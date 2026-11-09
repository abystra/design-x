import {pool} from '../packages/server-infra/src/db.js';
try{
 const generations=(await pool.query('SELECT execution_status,settlement_status,count(*)::int FROM creative_requests GROUP BY 1,2')).rows;
 const calls=(await pool.query('SELECT provider,model,cost_status,count(*)::int,sum(cost_usd) AS known_cost_usd FROM provider_calls GROUP BY 1,2,3')).rows;
 const holds=(await pool.query("SELECT count(*)::int AS reserved, count(*) FILTER(WHERE expires_at<now())::int AS overdue FROM quota_reservations WHERE status='reserved'")).rows[0];
 const leases=(await pool.query("SELECT count(*)::int AS active, count(*) FILTER(WHERE deadline_at<now() OR lease_until<now())::int AS expired FROM ai_attempts WHERE status='active'")).rows[0];
 const queues=(await pool.query("SELECT kind,status,count(*)::int,min(created_at) AS oldest FROM jobs WHERE status IN ('queued','running','failed') GROUP BY 1,2")).rows;
 console.log(JSON.stringify({at:new Date().toISOString(),generations,calls,holds,leases,queues},null,2));
}finally{await pool.end();}
