import {diffDesign} from '../../doc-core/src/index.js';
import type {Tx} from '../../server-infra/src/db.js';
import {id} from './common.js';
export async function recordOps(tx:Tx,workspaceId:string,doc:any,before:any,clientOpId?:string,submittedOps?:unknown[]){
 const ops=submittedOps||(doc.kind==='artboard'?diffDesign(before,doc.content):[{type:'replace_board',content:doc.content}]);
 const inverse=doc.kind==='artboard'?diffDesign(doc.content,before):[{type:'replace_board',content:before}];
 await tx.query('INSERT INTO document_ops(id,workspace_id,document_id,revision,client_op_id,ops,inverse_ops) VALUES($1,$2,$3,$4,$5,$6,$7)',[id(),workspaceId,doc.id,doc.revision,clientOpId||null,JSON.stringify(ops),JSON.stringify(inverse)]);
}
