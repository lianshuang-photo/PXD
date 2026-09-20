const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { PhotoshopBridge } = require('../companion/photoshop-bridge');
const { validate } = require('../companion/photoshop-tools');
const { CodexAgent } = require('../companion/codex-agent');
const { createAgentHttp } = require('../companion/agent-http');

test('tools reject raw execution, guessed argument shapes and oversized requests', () => {
  for (const [name, args] of [['batchPlay', {}], ['photoshop_get_document', {script:'delete'}], ['photoshop_get_layer', {documentId:1}], ['photoshop_list_layers', {documentId:1,limit:201}], ['photoshop_select_layers', {documentId:1,layerIds:[1,1]}], ['photoshop_render_preview',{documentId:1,maxEdge:4096}]]) assert.throws(() => validate(name,args));
  assert.deepEqual(validate('photoshop_select_layers',{documentId:1,layerIds:[2,3]}),{documentId:1,layerIds:[2,3]});
});
test('bridge binds jobs to the current host, accepts once and fails pending jobs on reload', async t => {
  const b = new PhotoshopBridge(); t.after(()=>b.close());
  await assert.rejects(b.request('photoshop_get_document',{}),/未连接/);
  let a=b.register({clientId:'host-0001'});
  const p=b.request('photoshop_get_document',{}), j=b.take('host-0001',a.hostToken);
  assert.equal(b.take('host-0001',a.hostToken),null);
  assert.throws(()=>b.result({clientId:'host-0001',id:j.id,result:{ok:true}},'bad'),/更新/);
  b.result({clientId:'host-0001',id:j.id,result:{ok:true,open:false}},a.hostToken);
  assert.equal((await p).open,false);
  assert.throws(()=>b.result({clientId:'host-0001',id:j.id,result:{ok:true}},a.hostToken),/结束/);
  const lost=b.request('photoshop_get_document',{}); const rejection=assert.rejects(lost,/中断/);
  b.register({clientId:'host-0002'}); await rejection;
  assert.equal(b.jobs.size,0);
});
test('expired jobs never replay and a disconnected capability check is truthful', async t => {
  const b=new PhotoshopBridge({timeoutMs:20});t.after(()=>b.close());
  b.register({clientId:'host-0001'});
  await assert.rejects(b.request('photoshop_get_document',{}),/超时/);
  assert.equal(b.jobs.size,0);b.disconnect();
  assert.equal((await b.request('photoshop_capabilities',{})).connected,false);
});
test('HTTP separates web clients, native host tokens and MCP tokens; abandoned polls clean up', async t=>{
  const b=new PhotoshopBridge(); const agent=new EventEmitter(); agent.photoshop=b;
  const service=createAgentHttp({agent});const server=http.createServer(async(req,res)=>{await service.handle(req,res,new URL(req.url,'http://localhost'));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{b.close();server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const post=(p,body,headers={})=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-PXDLS-Agent':'1',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/photoshop/register',{clientId:'host-0001'},{Origin:'http://127.0.0.1:17880'})).status,403);
  const registration=await (await post('/photoshop/register',{clientId:'host-0001'},{Origin:'null'})).json();
  assert.ok(registration.hostToken);
  assert.equal((await post('/photoshop/call',{tool:'photoshop_capabilities',arguments:{}})).status,403);
  const caps=await (await post('/photoshop/call',{tool:'photoshop_capabilities',arguments:{}},{'X-PXDLS-Tool':b.toolToken})).json();assert.equal(caps.connected,true);
  const controller=new AbortController();const pending=fetch(base+'/photoshop/jobs?clientId=host-0001',{headers:{'X-PXDLS-Agent':'1','X-PXDLS-Host':registration.hostToken},signal:controller.signal}).catch(()=>{});
  for(let n=0;n<30 && b.listenerCount('job')===0;n++) await new Promise(r=>setTimeout(r,5));
  assert.equal(b.listenerCount('job'),1);controller.abort();await pending;
  for(let n=0;n<30 && b.listenerCount('job');n++) await new Promise(r=>setTimeout(r,5));
  assert.equal(b.listenerCount('job'),0);
});
test('stdio MCP exposes tools and returns actual image content, including useful errors',async t=>{
  const server=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{assert.equal(req.headers['x-pxdls-tool'],'fixture-token');assert.equal(req.url,'/studio/mcp');const body=JSON.parse(data);assert.equal(body.operation,'observe');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body.arguments.tool==='photoshop_render_preview'?{ok:true,value:{ok:true,width:1,image:{base64:'aW1hZ2U=',mimeType:'image/png'}}}:{ok:false,error:{code:'HOST_UNAVAILABLE',message:'没有文档'}}));});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const child=spawn(process.execPath,[path.join(__dirname,'../companion/photoshop-mcp.cjs')],{env:{...process.env,PXDLS_BRIDGE_URL:'http://127.0.0.1:'+server.address().port,PXDLS_BRIDGE_TOKEN:'fixture-token'},stdio:['pipe','pipe','pipe']});
  t.after(()=>{child.kill();server.closeAllConnections();server.close();});
  const waiting=new Map();let text='',id=0;child.stdout.on('data',c=>{text+=c;let end;while((end=text.indexOf('\n'))>=0){const m=JSON.parse(text.slice(0,end));text=text.slice(end+1);waiting.get(m.id)(m.result);}});
  function rpc(method,params={}){return new Promise(resolve=>{waiting.set(++id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
  assert.equal((await rpc('initialize',{protocolVersion:'2024-11-05'})).serverInfo.name,'ls-photoshop');
  assert.equal((await rpc('tools/list')).tools.length,25);
  const image=await rpc('tools/call',{name:'photoshop_render_preview',arguments:{documentId:1}});
  assert.deepEqual(image.content[1],{type:'image',mimeType:'image/png',data:'aW1hZ2U='});
  assert.equal((await rpc('tools/call',{name:'photoshop_get_document',arguments:{}})).isError,true);
});
test('image tool events store a preview without persisting base64 in transcript text',t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ps-render-test-'));const agent=new CodexAgent({dataDir});t.after(()=>{agent.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  agent.normalizeItem({id:'preview-1',type:'mcpToolCall',server:'ls_photoshop',tool:'photoshop_render_preview',result:{content:[{type:'text',text:'{"width":1}'},{type:'image',mimeType:'image/png',data:'aW1hZ2U='}]}},'turn1',true);
  const row=agent.session.items.at(-1);assert.equal(row.title,'查看 PS 画面');assert.equal(row.output,'{"width":1}');assert.equal(row.previews.length,1);assert.ok(!JSON.stringify(agent.snapshot()).includes('aW1hZ2U='));
});
