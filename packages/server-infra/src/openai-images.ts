import { createHash } from 'node:crypto';
import { config } from './config.js';

export class ImageProviderError extends Error {
 constructor(public acceptance:'rejected'|'unknown',message:string,public requestId?:string){super(message);}
}
export interface ImageInput { prompt:string; size:string; model:string; quality:'medium'; workspaceId:string; references?:{bytes:Buffer;mime:string}[] }
export interface ImageResult { encoded:string; requestId:string|null; usage:unknown }
export interface ImageProvider { generate(input:ImageInput):Promise<ImageResult>; moderate(text:string,image?:Buffer):Promise<boolean> }
const MAX_RESPONSE_BYTES=48*1024*1024;
async function boundedJson(response:Response){
 if(Number(response.headers.get('content-length')||0)>MAX_RESPONSE_BYTES)throw new Error('供应商响应超出限制');
 const reader=response.body?.getReader();if(!reader)throw new Error('供应商响应为空');
 const chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_RESPONSE_BYTES)throw new Error('供应商响应超出限制');chunks.push(value);}}
 catch(error){await reader.cancel();throw error;}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// Native fetch has no application retries. An ambiguous POST is never replayed.
export function openaiImageProvider(transport:typeof fetch=fetch):ImageProvider {
 const headers={Authorization:`Bearer ${config.openaiApiKey}`};
 return {
  async generate(input){
   if(!config.openaiApiKey)throw new ImageProviderError('rejected','OpenAI 图片服务未配置');
   const edit=!!input.references?.length;
   const values={model:input.model,prompt:input.prompt,n:1,size:input.size,quality:input.quality,output_format:'png',safety_identifier:createHash('sha256').update(input.workspaceId).digest('hex')};
   let body:BodyInit,requestHeaders:Record<string,string>={...headers};
   if(edit){const form=new FormData();for(const [key,value] of Object.entries(values))form.append(key,String(value));for(const [i,ref] of input.references!.entries())form.append('image[]',new Blob([new Uint8Array(ref.bytes)],{type:ref.mime}),`reference-${i}.png`);body=form;}
   else {body=JSON.stringify(values);requestHeaders['Content-Type']='application/json';}
   let response:Response;
   try{response=await transport(`https://api.openai.com/v1/images/${edit?'edits':'generations'}`,{method:'POST',headers:requestHeaders,body,signal:AbortSignal.timeout(config.imageTimeoutMs),redirect:'error'});}
   catch{throw new ImageProviderError('unknown','图片供应商受理结果未知；请核对后再创建新请求');}
   const requestId=response.headers.get('x-request-id')||undefined;
   if(!response.ok){await response.body?.cancel();throw new ImageProviderError(response.status>=500||response.status===408?'unknown':'rejected',`OpenAI 图片请求返回 HTTP ${response.status}（模型 ${input.model}）；未自动重试或替换模型`,requestId);}
   try{const result=await boundedJson(response),encoded=result.data?.[0]?.b64_json;
    if(typeof encoded!=='string'||!encoded.length||encoded.length>MAX_RESPONSE_BYTES||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error('invalid result');
    return {encoded,requestId:requestId||null,usage:result.usage||null};
   }catch{throw new ImageProviderError('unknown','供应商已响应但结果未能完整读取；需要人工核对',requestId);}
  },
  async moderate(text,image){
   if(!config.openaiApiKey)throw new Error('OpenAI 审核服务未配置');
   const input:any[]=[{type:'text',text}];if(image)input.push({type:'image_url',image_url:{url:`data:image/png;base64,${image.toString('base64')}`}});
   const response=await transport('https://api.openai.com/v1/moderations',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({model:'omni-moderation-latest',input}),signal:AbortSignal.timeout(30000),redirect:'error'});
   if(!response.ok){await response.body?.cancel();throw new Error(`审核服务不可用（HTTP ${response.status}）`);}
   const result=await boundedJson(response);
   if(!Array.isArray(result.results)||!result.results.length||result.results.some((r:any)=>typeof r.flagged!=='boolean'))throw new Error('审核响应无效');
   return result.results.every((r:any)=>!r.flagged);
  },
 };
}

// Keep cost unknown unless an explicit versioned internal rate card covers all tokens.
export function priceImageUsage(usage:any):{costUsd:number|null;costStatus:string}{
 try{const rates=JSON.parse(process.env.OPENAI_IMAGE_PRICING_JSON||'null');
  const text=usage?.input_tokens_details?.text_tokens,image=usage?.input_tokens_details?.image_tokens,output=usage?.output_tokens;
  if(!rates?.version||rates.model!==config.imageModel||![text,image,output,rates.textInputPerMillion,rates.imageInputPerMillion,rates.outputPerMillion].every(v=>Number.isFinite(v)&&v>=0))return {costUsd:null,costStatus:'unknown'};
  return {costUsd:(text*rates.textInputPerMillion+image*rates.imageInputPerMillion+output*rates.outputPerMillion)/1e6,costStatus:`calculated:${rates.version}`};
 }catch{return {costUsd:null,costStatus:'unknown'};}
}
