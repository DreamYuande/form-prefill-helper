const assert = require('node:assert/strict');
const api = require('../qqform-prefill.user.js');
for(const remaining of [0,1,7,50,100,101,500,1000,1001,5000,5001,60000,60001,180000]) {
 const delay=api.nextDelay(remaining);assert(delay>=0&&delay<=30000&&delay<=remaining);
}
for(const initial of [1,50,999,1001,5001,60001,180000]) {
 let remaining=initial,steps=0;while(remaining>0){remaining-=api.nextDelay(remaining);assert(++steps<5000)}assert.equal(remaining,0);
}
const questions = [
 {id:'grade',title:'年级',type:'RADIO',dataType:1,required:true,qdata:{options:[{id:1,title:'2026级'},{id:2,title:'2025级及以上'}]}},
 {id:'sid',title:'学号',type:'SIMPLE',dataType:1,required:true},
 {id:'name',title:'姓名',type:'SIMPLE',dataType:1,required:true},
 {id:'class',title:'班级',type:'SIMPLE',dataType:1,required:true},
 {id:'multi',title:'多选',type:'CHECKBOX',dataType:1,qdata:{options:[{id:1,title:'A'},{id:2,title:'B'}]}},
 {id:'select',title:'下拉',type:'SELECT',dataType:1,qdata:{options:[{id:3,title:'C'}]}},
 {id:'date',title:'日期',type:'DATE',dataType:3},
 {id:'optional',title:'选填',type:'SIMPLE',dataType:1},
];
const schema=api.normalize({data:{globalPadId:'test$form',initialAttributedText:{text:JSON.stringify({questions,sections:[{qlist:questions.map(q=>q.id)}]})}}});
const values={grade:'1',sid:'TEST0001',name:'本地测试',class:'测试班',multi:['1','2'],select:'3',date:'2026年10月31日'};
const answers=api.buildAnswers(schema.questions,values);
assert.equal(answers.length,7);assert.equal(answers[0].data_type,1);assert.equal(answers[6].data_type,3);
assert.deepEqual(answers[0].selected_option_ids,['1']);assert.deepEqual(answers[0].content,{multi_texts:{texts:['2026级']}});
assert.throws(()=>api.buildAnswers(schema.questions,{...values,sid:''}),/学号/);
assert.throws(()=>api.buildAnswers(schema.questions,{...values,grade:'999'}),/选项/);
assert.throws(()=>api.buildAnswers([{id:'file',title:'附件',type:'FILE'}],{}),/暂不支持/);
assert.equal(api.parseTime('2026-10-31T20:26:00'),Date.parse('2026-10-31T12:26:00Z'));
assert(Number.isNaN(api.parseTime('garbage')));
assert.equal(api.openingTime('报名表 10-31 20:26开始',Date.parse('2026-10-24T12:00:00Z')),'2026-10-31T20:26:00');
(async()=>{
 let now=999,calls=0,saves=[];let complete;
 const state={phase:'armed',target:1000,payload:{form_id:'test',answers,role:{}}};
 const env={now:()=>now,save:s=>saves.push(s.phase),status:()=>{},send:async()=>{calls++;return new Promise(r=>{complete=r;});}};
 assert.equal(await api.runAttempt(state,env),false);assert.equal(calls,0);
 now=1000;const first=api.runAttempt(state,env);assert.equal(state.phase,'sending');assert.equal(calls,1);
 assert.equal(await api.runAttempt(state,env),false);complete({retcode:0,result:{seq:42}});await first;
 assert.equal(state.phase,'success');assert.equal(state.seq,'42');assert.equal(calls,1);assert.deepEqual(saves,['sending','success']);
 for(const [response,phase] of [[{retcode:5},'rejected'],[{retcode:0,result:{}},'unknown'],[{code:0,result:{seq:1}},'unknown']]){
  const st={phase:'armed',target:0};await api.runAttempt(st,{...env,send:async()=>response});assert.equal(st.phase,phase);
 }
 const st={phase:'armed',target:0};await api.runAttempt(st,{...env,send:async()=>{throw new Error('timeout');}});assert.equal(st.phase,'unknown');assert.equal(await api.runAttempt(st,env),false);
 console.log('PASS: schema/order, answer structures, required/options/unsupported validation, Beijing time, no early submission, in-flight deduplication, success/rejection/unknown states.');
})().catch(e=>{console.error(e);process.exitCode=1;});

