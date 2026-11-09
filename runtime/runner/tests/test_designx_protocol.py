import asyncio
import json
import time
from pathlib import Path
import pytest
from designx_runner.protocol import Journal, read_journal, validate_spec, write_command
from designx_runner.adapter import Adapter

def spec(tmp_path):
    return {"version":2,"codexVersion":"0.166.0","attemptId":"attempt-1","runId":"turn-1","sessionId":"session-1","projectId":"project-1","fence":3,
            "deadline":time.time()+60,"cwd":str(tmp_path/"work"),"stateDir":str(tmp_path/"state"),"runRoot":str(tmp_path/"root"),"binary":"/usr/bin/codex","modelCatalog":"/tmp/models.json",
            "prompt":"Create poster","model":"deepseek-flash","limits":{"toolCalls":60,"outputBytes":1024*1024},"tools":[]}

def test_journal_cursor_and_partial_tail(tmp_path):
    value=spec(tmp_path); journal=Journal(value)
    journal.emit("session.ready",{"threadId":"t1"}); journal.emit("turn.started",{})
    assert [e['sequence'] for e in read_journal(journal.root,1)['events']]==[2]
    with journal.path.open('ab') as f:f.write(b'{"sequence":3')
    assert read_journal(journal.root,2)=={'events':[],'cursor':2}

def test_command_idempotency_and_conflict(tmp_path):
    tmp_path.mkdir(exist_ok=True)
    command={'commandId':'stop-1','type':'stop','attemptId':'attempt-1','fence':3}
    write_command(tmp_path,command);write_command(tmp_path,command)
    assert len(list((tmp_path/'commands').glob('*.json')))==1
    with pytest.raises(ValueError):write_command(tmp_path,{**command,'fence':4})
    with pytest.raises(ValueError):write_command(tmp_path,{**command,'commandId':'../escape'})

@pytest.mark.parametrize('field,value', [('codexVersion','0.144.0'),('fence',0),('deadline',0),('attemptId','../evil'),('binary','codex')])
def test_reject_bad_run_contract(tmp_path,field,value):
    data=spec(tmp_path);data[field]=value
    with pytest.raises(ValueError):validate_spec(data)

async def test_question_wait_does_not_block_stop(tmp_path):
    value=spec(tmp_path); journal=Journal(value); adapter=Adapter(value,journal)
    adapter.thread_id='thread1';adapter.turn_id='turn1'
    controls=asyncio.create_task(adapter.controls())
    question=asyncio.create_task(adapter.request_input(1,{'threadId':'thread1','turnId':'turn1','questions':[{'id':'q1','question':'Which size?'}]}))
    await asyncio.sleep(0.02)
    write_command(journal.root,{'commandId':'cancel-1','attemptId':'attempt-1','fence':3,'type':'stop'})
    with pytest.raises(asyncio.CancelledError): await asyncio.wait_for(question,1)
    assert adapter.stopped.is_set()
    controls.cancel();await asyncio.gather(controls,return_exceptions=True)
    events=read_journal(journal.root,0)['events']
    assert any(e['type']=='command.ack' and e['payload']['status']=='applied' for e in events)

async def test_stale_fence_cannot_answer(tmp_path):
    value=spec(tmp_path); journal=Journal(value); adapter=Adapter(value,journal)
    adapter.thread_id='thread1';adapter.turn_id='turn1'
    controls=asyncio.create_task(adapter.controls())
    question=asyncio.create_task(adapter.request_input('r1',{'threadId':'thread1','questions':[{'id':'q1'}]}))
    await asyncio.sleep(0.01)
    write_command(journal.root,{'commandId':'answer-1','attemptId':'attempt-1','fence':2,'type':'answer','requestId':'r1','answers':{'q1':{'answers':['yes']}}})
    await asyncio.sleep(0.15)
    assert not question.done()
    question.cancel();controls.cancel();await asyncio.gather(question,controls,return_exceptions=True)

def test_native_tool_aliases_are_unambiguous(tmp_path):
    value=spec(tmp_path)
    value['tools']=[{'name':name,'inputSchema':{}} for name in ['assets.list','assets_list']]
    with pytest.raises(ValueError,match='aliases'): validate_spec(value)

async def test_native_tool_call_maps_to_business_catalog(tmp_path):
    value=spec(tmp_path);value['tools']=[{'name':'assets.list','description':'List','inputSchema':{}}]
    journal=Journal(value);adapter=Adapter(value,journal);adapter.thread_id='native1'
    call=asyncio.create_task(adapter.tool('server1',{'threadId':'native1','callId':'call1','tool':'assets_list','arguments':{}}))
    await asyncio.sleep(0)
    event=read_journal(journal.root,0)['events'][0]
    assert event['payload']['name']=='assets.list'
    adapter.pending['tool-call1'].set_result({'success':True,'result':{'assets':[]}})
    assert (await call)['success'] is True
