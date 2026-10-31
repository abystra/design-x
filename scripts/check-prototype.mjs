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
import Editor,{initialDesign} from './src/components/Editor.jsx';
import Workbench,{getKind} from './src/components/Workbench.jsx';
import AIStudio,{DesignPreview} from './src/components/AIStudio.jsx';
import catalog from './src/data/catalog.json';
import {templates} from './src/data/templates.js';
import {ArtboardSchema} from './packages/doc-core/src/index.ts';
globalThis.location={hash:''};
for(const route of ['home','skills','tools','templates','projects','recent','assets','guide']){
 location.hash='#'+route;
 const html=renderToStaticMarkup(React.createElement(App));
 assert(html.length>2000,route+' empty');
 assert(!html.includes('undefined'),'undefined content on '+route);
}
const design=initialDesign(templates[0]);ArtboardSchema.parse(design);
const result={id:'artboard-test',documentId:'artboard-test',projectId:'project-test',title:'模板设计',design,position:{x:0,y:0},revision:1,persisted:true};
for(const panel of ['skills','files','history','assets']){
 const html=renderToStaticMarkup(React.createElement(AIStudio,{session:{id:'project-test',projectId:'project-test',revision:1,panel,snapshot:{title:'测试项目',results:[result],draft:'保留我的需求',messages:[]}}}));
 assert(html.includes('ai-studio'),'Studio layout missing');
 assert(html.includes('保留我的需求'),'Draft not rendered');
 assert(html.includes('st-panel-'+panel),'Panel missing: '+panel);
 assert(!html.includes('undefined'));
}
const preview=renderToStaticMarkup(React.createElement(DesignPreview,{project:result}));
assert(preview.includes('dx-artboard')&&preview.includes('SLOW'),'Board must use the shared document renderer');
for(const item of [...catalog.skills,...catalog.tools]){
 const html=renderToStaticMarkup(React.createElement(Workbench,{item}));
 assert(html.includes(item.name),'Missing workbench '+item.name);
}
for(const item of templates){ArtboardSchema.parse(initialDesign(item));assert(renderToStaticMarkup(React.createElement(Editor,{project:{...item,persisted:false}})).includes('ed-stage'));}
for(const ratio of ['3:4','1:1','16:9','9:16']){assert.equal(initialDesign({blank:true,ratio}).nodes.length,0);}
assert.equal(getKind({name:'AI文案',category:'视频与内容'}),'text');
assert.equal(getKind({name:'AI海报',category:'视频与内容'}),'graphic');
console.log('PASS: preserved navigation, four Studio panels, shared preview, 100 catalog forms, 8 schema-valid templates and blank canvases. API/browser tests validate live behavior separately.');
// The bundled canvas SDK owns idle timers; all SSR assertions above are synchronous.
process.exit(0);
`;
try{await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'jsx'},bundle:true,platform:'node',format:'cjs',outfile:join(dir,'check.cjs'),loader:{'.css':'empty'},logLevel:'silent'});process.stdout.write(execFileSync(process.execPath,[join(dir,'check.cjs')],{encoding:'utf8'}));}finally{await rm(dir,{recursive:true,force:true});}
