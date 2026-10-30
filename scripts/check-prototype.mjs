import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'design-x-check-'));
const entry=`
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';
import App from './src/App.jsx';
import Editor from './src/components/Editor.jsx';
import Workbench,{getKind,buildResults} from './src/components/Workbench.jsx';
import AIStudio,{DesignPreview} from './src/components/AIStudio.jsx';
import {buildBrief,buildStudioResults} from './src/lib/studioModel.js';
import {encodeStudioSession} from './src/lib/studioSession.js';
import catalog from './src/data/catalog.json';
import {templates} from './src/data/templates.js';
const storage=new Map();
globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
globalThis.location={hash:''};
for(const route of ['home','skills','tools','templates','projects','recent','assets','guide','studio']){
 location.hash='#'+route;
 const html=renderToStaticMarkup(React.createElement(App));
 assert(html.length>3000,route+' empty');
 assert(!html.includes('undefined'),'undefined content on '+route);
 if(route==='studio'){
  assert(html.includes('ai-studio'),'Studio route must open the AI workspace.');
  assert(!html.includes('class="sidebar"'),'Studio route must not retain the homepage navigation shell.');
  assert(html.includes('告诉 AI 你的设计需求'));
 }
}

const studioBrief={...buildBrief({prompt:'设计两张咖啡海报，标题“秋日来信”',count:2,assets:[{id:'test-coffee',name:'验收素材.jpg',url:'/assets/coffee.jpg'}]}),sessionId:'ssr-session',turn:1};
const studioResults=buildStudioResults(studioBrief).map((result,index)=>({...result,persisted:false,position:{x:index*310,y:0}}));
const completeMessages=[
 {id:'user-1',role:'user',text:studioBrief.prompt,assets:studioBrief.assets,skill:'营销海报'},
 {id:'assistant-1',role:'assistant',text:'方案已就绪',status:'complete',resultIds:studioResults.map(result=>result.id)}
];
const studioSnapshot={id:'ssr-session',title:'验收创作',results:studioResults,messages:completeMessages,assets:studioBrief.assets,attached:[],draft:'接着调整细节',ratio:'自动',count:'自动',selected:studioResults[0].id,view:{x:70,y:140,zoom:1}};
const renderStudio=(session)=>renderToStaticMarkup(React.createElement(AIStudio,{session,onBack:()=>{},onNew:()=>{},onEdit:()=>{},onSave:()=>true}));
for(const [panel,expected] of [['skills','搜索工作区技能'],['files','验收素材.jpg'],['history','复用这次需求'],['assets','示例素材']]){
 const html=renderStudio({id:'ssr-'+panel,panel,snapshot:studioSnapshot});
 assert(html.includes('st-panel-'+panel),'Missing studio panel '+panel);
 assert(html.includes(expected),'Panel content is missing: '+panel);
 assert(html.includes('接着调整细节'),'Switching panels must retain the draft.');
 assert(!html.includes('undefined'),'Invalid content in studio panel '+panel);
}
const populated=renderStudio({id:'ssr-results',panel:null,snapshot:studioSnapshot});
assert.equal((populated.match(/class="st-result-label"/g)||[]).length,2,'Every generated result must appear on the canvas.');
assert(populated.includes('秋日来信'),'Editable title must be rendered in the result preview.');
assert(populated.includes('继续修改')&&populated.includes('精细编辑'),'Selected results must expose refinement and editor actions.');
assert(populated.includes('接着调整细节'),'Restored text input must retain its draft.');
assert(populated.includes('clip-studio-'),'Result previews must render structured SVG layers.');
const preview=renderToStaticMarkup(React.createElement(DesignPreview,{project:studioResults[0]}));
assert(preview.includes('foreignObject')&&preview.includes('/assets/coffee.jpg'),'Preview must show editable text and image layers.');
const emptyPreview=renderToStaticMarkup(React.createElement(DesignPreview,{project:{id:'blank-preview',title:'自由画板',design:{width:600,height:800,background:'#ffffff',nodes:[]}}}));
assert(emptyPreview.includes('viewBox="0 0 600 800"'));
assert(!emptyPreview.includes('<image'),'An empty canvas must stay empty.');

const runningMessages=[completeMessages[0],{id:'assistant-running',role:'assistant',text:'正在生成',status:'running',context:{brief:studioBrief,previous:null}}];
const resumed=renderStudio({id:'ssr-resume',panel:null,snapshot:{...studioSnapshot,results:[],messages:runningMessages,selected:null}});
assert(resumed.includes('上次创作已暂停'),'Interrupted generation must restore as paused, not as a stuck spinner.');
assert(resumed.includes('重新生成'),'An interrupted generation must offer a retry.');
assert(resumed.includes('验收素材.jpg'),'Restored generation must retain its original material context.');
assert(!resumed.includes('class="st-progress"'),'No generation progress should run during SSR restoration.');
assert(!resumed.includes('st-canvas-loading'),'A restored interrupted request must not show live canvas loading.');
const emptyHistory=renderStudio({id:'ssr-empty-history',panel:'history'});
assert(emptyHistory.includes('让第一段对话从这里开始'));
const emptyFiles=renderStudio({id:'ssr-empty-files',panel:'files'});
assert(emptyFiles.includes('这里还没有素材'));

storage.set('dx-ai-studio',JSON.stringify(studioSnapshot));
location.hash='#studio';
const restoredRoute=renderToStaticMarkup(React.createElement(App));
assert(restoredRoute.includes('验收创作')&&restoredRoute.includes('秋日来信'),'The studio route must restore the saved conversation and canvas.');
storage.set('dx-ai-studio',encodeStudioSession(studioSnapshot));
const packedRestoredRoute=renderToStaticMarkup(React.createElement(App));
assert(packedRestoredRoute.includes('验收创作')&&packedRestoredRoute.includes('秋日来信'),'The studio route must restore the packed session format.');
storage.clear();

const newResultEditor=renderToStaticMarkup(React.createElement(Editor,{project:studioResults[0]}));
assert(newResultEditor.includes('有未保存更改'),'A new studio result must not claim to be saved.');
assert(newResultEditor.includes('秋日来信'),'Editor must receive the result design rather than a fallback template.');
const savedResultEditor=renderToStaticMarkup(React.createElement(Editor,{project:{...studioResults[0],persisted:true}}));
assert(savedResultEditor.includes('已保存')&&!savedResultEditor.includes('有未保存更改'),'Persisted projects should restore their saved status.');
const convertedShots=buildStudioResults(buildBrief({prompt:'把这组设计变成视频分镜',mode:'视频生成'}),{previous:studioResults[0],revision:'把这组设计变成视频分镜'});
assert.equal(convertedShots[0].outputKind,'storyboard','Switching a referenced poster to video mode must produce storyboard previews.');
assert.equal(convertedShots[0].ratio,'9:16','Automatic video conversion should choose a portrait video canvas.');
assert.equal(convertedShots[0].image,studioResults[0].image,'Mode conversion must preserve the referenced material.');
assert(convertedShots[0].title.includes('广告分镜'));
const convertedGraphic=buildStudioResults(buildBrief({prompt:'再做一张图片',mode:'图片生成'}),{previous:convertedShots[0],revision:'再做一张图片'});
assert.equal(convertedGraphic[0].outputKind,'graphic');
assert.equal(convertedGraphic.length,1);
for(const item of [...catalog.skills,...catalog.tools]){
 const html=renderToStaticMarkup(React.createElement(Workbench,{item}));
 assert(html.includes(item.name),'Missing workbench '+item.name);
}
for(const item of templates){assert(renderToStaticMarkup(React.createElement(Editor,{project:item})).includes('ed-stage'));}
for(const ratio of ['3:4','1:1','16:9','9:16']){
 const html=renderToStaticMarkup(React.createElement(Editor,{project:{blank:true,ratio}}));
 assert(!html.includes('A LITTLE'),'Blank canvas contains template');
}
assert.equal(getKind({name:'AI文案',category:'视频与内容'}),'text');
assert.equal(getKind({name:'AI海报',category:'视频与内容'}),'graphic');
assert.equal(getKind({name:'LivePPT',category:'穿戴与办公'}),'document');
assert.equal(getKind({name:'证件照',category:'穿戴与办公'}),'graphic');
assert.equal(getKind({name:'智能抠图',category:'图片处理'}),'image');
const config={ratio:'4:3',style:'自然清新',image:'/assets/coffee.jpg',name:'验收咖啡',prompt:'测试主题',selling:'本地素材',types:['白底图','场景图'],count:6,pages:8,duration:30};
for(const [kind,count] of [['product',6],['graphic',6],['video',4],['document',8],['text',3]]){
 const results=buildResults(config,kind);assert.equal(results.length,count);
 for(const r of results){assert.equal(r.image,config.image);assert.equal(r.design.width/r.design.height,4/3);assert(r.design.nodes.some(n=>n.src===config.image));assert.equal(r.config.name,config.name);}
}
console.log('PASS: 9 routes, 4 studio panels, result previews, session/resume states, editor save status, 100 task forms, 8 templates, 4 blank ratios and 5 output structures.');
`;
try{await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'jsx'},bundle:true,platform:'node',format:'cjs',outfile:join(dir,'check.cjs'),loader:{'.css':'empty'},logLevel:'silent'});process.stdout.write(execFileSync(process.execPath,[join(dir,'check.cjs')],{encoding:'utf8'}));}finally{await rm(dir,{recursive:true,force:true});}
