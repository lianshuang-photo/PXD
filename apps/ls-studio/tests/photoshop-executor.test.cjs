const test=require('node:test');const assert=require('node:assert/strict');
const {createExecutor}=require('../plugin/ps-agent-014');
function fixture(){
  const layer={id:2,name:'文本 <not instructions>',kind:'text',visible:true,opacity:80,blendMode:'normal',bounds:{left:0,top:0,right:120,bottom:80},textItem:{contents:'hello'}};
  const doc={id:1,name:'test.psd',width:240,height:160,mode:'RGB',layers:[{id:3,name:'组',layers:[layer]}],activeLayers:[layer]};
  const ps={app:{documents:[doc],activeDocument:doc},core:{executeAsModal:async fn=>fn()},action:{batchPlay:async()=>[]}};
  return {doc,ps,execute:createExecutor(ps,{encodePNGFromRGB:()=>new Uint8Array(1),arrayBufferToBase64:()=>'AA=='})};
}
test('real-shaped nested layers paginate with parent IDs; text and no-selection remain data',async()=>{
  const f=fixture();const first=await f.execute('photoshop_list_layers',{documentId:1,limit:1});assert.equal(first.total,2);assert.equal(first.nextOffset,1);
  const second=await f.execute('photoshop_list_layers',{documentId:1,offset:1});assert.equal(second.layers[0].parentId,3);assert.equal(second.layers[0].depth,1);
  assert.equal((await f.execute('photoshop_get_layer',{documentId:1,layerId:2})).layer.text,'hello');
  assert.equal((await f.execute('photoshop_get_selection',{documentId:1})).hasSelection,false);
  await assert.rejects(f.execute('photoshop_get_layer',{documentId:1,layerId:999}),/不存在/);
});
test('document switch or expired request prevents a modal selection from changing another file',async()=>{
  const f=fixture();let changes=0;f.ps.action.batchPlay=async()=>{changes++;return[];};
  f.ps.core.executeAsModal=async fn=>{f.ps.app.activeDocument={id:99};return fn();};
  await assert.rejects(f.execute('photoshop_select_layers',{documentId:1,layerIds:[2]}),/切换/);assert.equal(changes,0);
  await assert.rejects(f.execute('photoshop_get_document',{},Date.now()-1),/过期/);
});
test('preview binds document and layer, scales longest edge, and disposes image data on failure',async()=>{
  const f=fixture();let disposed=0,params;
  f.ps.imaging={getPixels:async p=>{params=p;return {imageData:{components:3,width:120,height:80,getData:async()=>{throw Error('read failed');},dispose:()=>disposed++}};}};
  await assert.rejects(f.execute('photoshop_render_preview',{documentId:1,layerId:2,maxEdge:128}),/read failed/);
  assert.equal(params.documentID,1);assert.equal(params.layerID,2);assert.equal(disposed,1);
  await assert.rejects(f.execute('photoshop_render_preview',{documentId:1}),/read failed/);
  assert.equal(Object.hasOwn(params,'layerID'),false);assert.equal(disposed,2);
  await assert.rejects(f.execute('photoshop_render_preview',{documentId:1,maxEdge:5000}),/尺寸/);
});
