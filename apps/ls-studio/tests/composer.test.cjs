const test=require('node:test');const assert=require('node:assert/strict');
const {attach}=require('../plugin/composer-014');
function fixture(t,native=true){
  const field=new EventTarget(),document=new EventTarget();field.value='';field.focus=()=>field.dispatchEvent(new Event('focus'));
  const classes=new Set(),frame={classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)}};
  let sends=0,saved='',enabled=true;
  const control=attach({field,frame,document,native,enterSends:()=>enabled,send:()=>sends++,saveDraft:()=>saved=field.value});t.after(()=>control.close());
  function event(type,props={}){const e=new Event(type,{cancelable:true});Object.assign(e,props);field.dispatchEvent(e);return e;}
  function input(text,props){field.value=text;return event('input',props);}
  return {field,control,event,input,classes,sends:()=>sends,saved:()=>saved,disable:()=>enabled=false};
}
test('Enter sends once; repeat, Shift+Enter and composing Enter do not send',t=>{
  const f=fixture(t);f.input('test');assert.equal(f.event('keydown',{key:'Enter'}).defaultPrevented,true);assert.equal(f.sends(),1);
  f.event('keydown',{key:'Enter',repeat:true});f.event('keydown',{key:'Enter',shiftKey:true});f.event('compositionstart');f.event('keydown',{key:'Enter'});f.input('test\n',{isComposing:true});assert.equal(f.sends(),1);
});
test('UXP swallowed keydown falls back to a single newline input and retains the draft',t=>{
  const f=fixture(t);f.input('消息');f.input('消息\n');assert.equal(f.sends(),1);assert.equal(f.field.value,'消息');assert.equal(f.saved(),'消息');
});
test('multiline replacement/paste and Enter-newline preference cannot submit accidentally',t=>{
  const f=fixture(t);f.input('one\ntwo');assert.equal(f.sends(),0);f.event('paste');f.input('one\ntwo\n');assert.equal(f.sends(),0);
  f.disable();f.event('keydown',{key:'Enter'});f.input('one\ntwo\n\n');assert.equal(f.sends(),0);
});
test('newline action inserts at the caret and focus feedback clears on blur',t=>{
  const f=fixture(t);f.input('abcd');f.field.selectionStart=2;f.field.selectionEnd=3;f.control.newline();assert.equal(f.field.value,'ab\nd');assert.equal(f.sends(),0);assert.equal(f.classes.has('is-focused'),true);f.event('blur');assert.equal(f.classes.has('is-focused'),false);
});
