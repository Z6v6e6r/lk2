"""CI-only kernel rehearsal: private network, trusted exit and owned slice stop ACK.

No Docker, database, enrolled source/config or original operator request is used.
Only random transient test units/slices and a private /root fixture directory exist.
"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch
import uuid

spec=importlib.util.spec_from_file_location('backup',Path(__file__).with_name('control-timeweb-database-backup.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def rehearsal():
    m.need(sys.platform=='linux' and os.getuid()==0 and sys.flags.isolated==1
           and socket.gethostname()!='msk-1-vm-z8ks', 'FIXTURE_HOST')
    m.need(Path('/run/systemd/system').is_dir() and not m.ROOT.exists(), 'FIXTURE_LIVE_ROOT')
    results=[]
    for after in [False,True]:
        with tempfile.TemporaryDirectory(prefix='phub-backup-rehearsal-',dir='/root') as directory:
            root=Path(directory);work=root/'work';work.mkdir(mode=0o700)
            sha=m.digest(uuid.uuid4().bytes);unit='phub-disk-runtime-'+sha[:24]+'.service';sl='phubdiskrestore'+sha[:24]+'.slice'
            p={'work':str(work),'operationSha256':sha,'image':str(root/'image'),'mount':str(root/'mount'),
               'mapperPath':str(root/'mapper'),'isolation':{'unit':unit,'slice':sl}}
            request=root/'operation.json';request.write_text('{}');request.chmod(0o600)
            tool=root/'operator/tools'/m.NOTIFICATION_EARLY_SOURCE/'control-timeweb-database-backup.py'
            tool.parent.mkdir(parents=True);network=root/'network.json'
            tool.write_text("import json,pathlib,os,sys,socket,time\nt=time.process_time()\nwhile time.process_time()-t<1.2: pass\npathlib.Path("+repr(str(network))+").write_text(json.dumps({'net':os.stat('/proc/self/ns/net').st_ino,'interfaces':socket.if_nameindex(),'routes':pathlib.Path('/proc/net/route').read_text().splitlines()[1:]}))\nsys.exit(1)\n")
            tool.chmod(0o755);events={'NAMESPACE_UNIT_START_INTENT':{},'NAMESPACE_STORAGE_CLEANED':{},'NAMESPACE_RELEASED':{}}
            journal=SimpleNamespace(find=events.get,add=lambda phase,**metadata:events.__setitem__(phase,metadata),
                once=lambda phase,**metadata:events.__setitem__(phase,metadata),events=[{}]*11+[{'observedAt':m.now_iso()}])
            with patch.object(m,'ROOT',root),patch.object(m,'REQUEST',request),patch.object(m,'NOTIFICATION_EARLY_OPERATION',sha):
                m.namespace_require_absent(unit);m.namespace_require_absent(sl)
                try:
                    try:m.notification_early_systemd(p,journal)
                    except m.Stop:pass
                    else:raise AssertionError('before-ACK state accepted')
                    m.command(m.namespace_slice_args(p),'FIXTURE_SLICE',timeout=15)
                    events['NAMESPACE_SLICE_START_INTENT']={};events['NAMESPACE_SLICE_READY']={'identity':m.namespace_slice(p)}
                    m.command(m.namespace_unit_args(p,tool),'FIXTURE_UNIT',timeout=15)
                    deadline=time.monotonic()+30
                    while time.monotonic()<deadline:
                        if network.exists() and m.namespace_unit(p)['LoadState']=='not-found':break
                        time.sleep(.2)
                    else:raise AssertionError('unit did not reach collected terminal state')
                    net=json.loads(network.read_text())
                    m.need(net['net']!=os.stat('/proc/self/ns/net').st_ino and net['routes']==[]
                           and [v[1] for v in net['interfaces']]==['lo'],'FIXTURE_PRIVATE_NETWORK')
                    raw=m.command(['/usr/bin/journalctl','--boot=0','--unit='+unit,'--output=json','--no-pager'],'FIXTURE_JOURNAL')
                    rows=[m.strict(line) for line in raw.splitlines()]
                    m.need(len(rows)==5,'FIXTURE_SYSTEMD_ROWS')
                    frozen=m.digest((json.dumps(rows,sort_keys=True,separators=(',',':'))+'\n').encode())
                    with patch.object(m,'NOTIFICATION_EARLY_SYSTEMD',frozen),patch.object(m,'NOTIFICATION_EARLY_INVOCATION',rows[0]['INVOCATION_ID']):
                        m.notification_early_systemd(p,journal)
                    source={'mountNamespace':os.stat('/proc/self/ns/mnt').st_ino}
                    original=m.command;injected=False
                    def stop_ack(args,code,**kwargs):
                        nonlocal injected
                        if code=='NS_SLICE_STOP' and not injected:
                            injected=True
                            if after:original(args,code,**kwargs)
                            raise m.Stop('FIXTURE_STOP_ACK_UNKNOWN')
                        return original(args,code,**kwargs)
                    with patch.object(m,'namespace_frozen_source',return_value=source),patch.object(m,'command',side_effect=stop_ack):
                        try:m.namespace_release(p,{},journal)
                        except m.Stop as error:m.need(str(error)=='FIXTURE_STOP_ACK_UNKNOWN','FIXTURE_UNEXPECTED_STOP')
                        else:raise AssertionError('fault not injected')
                    with patch.object(m,'namespace_frozen_source',return_value=source):m.namespace_release(p,{},journal)
                    m.namespace_slice_terminal(p,journal)
                    m.need(events.get('NAMESPACE_SLICE_RELEASED')=={} and not m.namespace_members('/'+sl),'FIXTURE_RELEASE')
                    reread=original(['/usr/bin/journalctl','--boot=0','--unit='+unit,'--output=json','--no-pager'],'FIXTURE_JOURNAL')
                    m.need([m.strict(v) for v in reread.splitlines()]==rows,'FIXTURE_UNIT_REPLAY')
                    results.append({'lostStopAck':'after' if after else 'before','privateNetwork':True,
                        'trustedExitProof':True,'ownedSliceReleased':True,'unitReplayed':False})
                finally:
                    for name in [unit,sl]:
                        subprocess.run(['/usr/bin/systemctl','stop',name],stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False)
    print(json.dumps({'status':'PHYSICAL_REHEARSAL_PASS','cases':results,'databaseContacted':False,
                      'fullRecoveryFlow':False}))


if __name__=='__main__':rehearsal()
