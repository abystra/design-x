import test from 'node:test';import assert from 'node:assert/strict';
import {openaiImageProvider,ImageProviderError,priceImageUsage} from '../../packages/server-infra/src/openai-images.js';
import {config} from '../../packages/server-infra/src/config.js';
const input={workspaceId:'workspace',model:config.imageModel,quality:'medium' as const,prompt:'a lamp',size:'1024x1024'};
if(!config.openaiApiKey)config.openaiApiKey='test-only';
test('synchronous Image API expands n=1, uses fixed model, and never retries ambiguous submission',async()=>{
 let calls=0;const provider=openaiImageProvider((async(url,options)=>{calls++;assert.equal(String(url),'https://api.openai.com/v1/images/generations');const body=JSON.parse(String(options?.body));assert.equal(body.n,1);assert.equal(body.model,'gpt-image-2.5-sunburst-2026-09-08');throw new Error('connection reset');}) as typeof fetch);
 await assert.rejects(()=>provider.generate(input),(e:any)=>e instanceof ImageProviderError&&e.acceptance==='unknown');assert.equal(calls,1);
});
test('4xx rejection and ambiguous 5xx are distinguished without reading provider error text',async()=>{
 for(const status of [400,401,404,408,429,500,503]){let calls=0;const p=openaiImageProvider((async()=>{calls++;return new Response('private upstream text',{status});}) as typeof fetch);await assert.rejects(()=>p.generate(input),(e:any)=>{assert.equal(e.acceptance,status===408||status>=500?'unknown':'rejected');assert.ok(!e.message.includes('private'));return true;});assert.equal(calls,1);}
});
test('edit uses multipart references and successful output is returned without a provider polling id',async()=>{
 const p=openaiImageProvider((async(url,options)=>{assert.ok(String(url).endsWith('/images/edits'));assert.ok(options?.body instanceof FormData);assert.equal(options.body.getAll('image[]').length,1);return Response.json({data:[{b64_json:Buffer.from('png').toString('base64')}],usage:{output_tokens:5}},{headers:{'x-request-id':'request-a'}});}) as typeof fetch);
 const result=await p.generate({...input,references:[{bytes:Buffer.from('png'),mime:'image/png'}]});assert.equal(result.requestId,'request-a');assert.equal(result.encoded,'cG5n');
});
test('missing rate card never reports unknown supplier cost as zero',()=>{const old=process.env.OPENAI_IMAGE_PRICING_JSON;delete process.env.OPENAI_IMAGE_PRICING_JSON;assert.deepEqual(priceImageUsage({output_tokens:10}),{costUsd:null,costStatus:'unknown'});if(old)process.env.OPENAI_IMAGE_PRICING_JSON=old;});
