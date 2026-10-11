import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fixture = `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseDirectRecipientPolicy, directRecipientCaptureReviewSha256, buildDirectRecipientEvidence} from './scripts/timeweb-direct-recipient-evidence.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const bytes=x=>Buffer.from(JSON.stringify(x));
const base=Date.parse('2026-10-11T10:00:00.000Z');
const at=s=>new Date(base+s*1000).toISOString();
const trust='APPROVED_READER_HUMAN_REVIEW_V1';
const nonce='1234567890abcdef1234567890abcdef';
const target={hostname:'lk2.padlhub.su',serverId:8886471,projectId:262717};
const binding={sourceSha:'a'.repeat(40),sourceTree:'b'.repeat(40),releaseId:'a'.repeat(40)+'-123-1',operationSha256:'c'.repeat(64),contractSha256:'d'.repeat(64),collectorSourceSha256:'e'.repeat(64)};
const monitors=[
 {service:'api',id:'26ed404e-98e5-45c5-98e3-31b9dfd6f0f2',name:'lk2-beta-api-ready',url:'https://lk2.padlhub.su/health/ready'},
 {service:'web',id:'b25e28a0-02d8-49e4-a0a1-f49f62abc02c',name:'lk2-beta-web-root',url:'https://lk2.padlhub.su/'}
];
function setup(){
 const policy={schema:'PHUB_TIMEWEB_DIRECT_RECIPIENT_POLICY_V1',state:'REVIEWED_PRIVATE_INPUT',trust,target,binding,nonce,reader:'synthetic-reader',owner:{identity:'owner-1',role:'release-owner',account:'tg-account',peer:'saved-messages'},recipients:{email:{account:'recipient@example.test',sender:'notifier@example.test'},telegram:{account:'tg-account',sender:'monitor-bot',peer:'bot-peer'}},templates:{email:{alert:'{{monitorName}} ALERT nonce {{nonce}}',recovery:'{{monitorName}} RECOVERY nonce {{nonce}}'},telegram:{alert:'{{monitorName}} ALERT nonce {{nonce}}',recovery:'{{monitorName}} RECOVERY nonce {{nonce}}'}},configuration:{monitors:monitors.map(({service,...m})=>({...m,enabled:true,method:'GET',expectedStatus:200,regions:['synthetic-region-1','synthetic-region-2'],intervalSeconds:60,timeoutSeconds:10,authorizationHeaderConfigured:true})),deliveryChannels:['email','telegram']},captureReviewSha256:null};
 const bundle={schema:'PHUB_TIMEWEB_DIRECT_RECIPIENT_CAPTURE_V1',target,policySha256:null,operationSha256:binding.operationSha256,nonce,reader:policy.reader,captures:[],gmailSearch:{query:'after:'+Math.floor((base-1000)/1000)+' before:'+Math.floor((base+1114000)/1000)+' in:anywhere "'+nonce+'"',windowEndAt:at(1113),pageRoles:['gmail-search-1']}};
 const files=new Map();
 const add=(role,kind,second,assertion,raw=bytes({fixture:'SYNTHETIC_ONLY_NOT_A_NATIVE_SOURCE',role}))=>{
  const c={role,kind,toolVersion:'SYNTHETIC_TEST_ONLY',callId:'call-'+role,reader:policy.reader,capturedAt:at(second),rawFile:'raw/'+role+'.bin',rawSize:raw.length,rawSha256:hash(raw),assertion};
  files.set(c.rawFile,raw);bundle.captures.push(c);return c;
 };
 add('panel-configuration','timeweb-panel',1113,{source:'OPERATOR_ATTESTED_PANEL_CONFIGURATION',configurationSha256:hash(bytes(policy.configuration))});
 add('gmail-account','gmail',1112,{source:trust,account:policy.recipients.email.account});
 add('owner-account','telegram-desktop-export',1112,{source:trust,account:policy.owner.account,peer:policy.owner.peer,identity:policy.owner.identity});
 const ids=[];
 monitors.forEach((m,index)=>{
  const t=index*120;
  for(const [role,event,second] of [['trigger','TRIGGER',t],['recovery-start','RECOVERY_START',t+60]]) add(m.service+'-'+role,'approved-operator-event-trace',second+1,{source:'APPROVED_OPERATOR_TRANSITION_LOWER_BOUND_V1',monitorId:m.id,event,operationSha256:binding.operationSha256,nonce,at:at(second)});
  for(const [event,offset] of [['alert',0],['recovery',60]]) for(const [channel,delay] of [['email',10],['telegram',20]]) {
   const id=m.service+'-'+channel+'-'+event;
   const recipient=policy.recipients[channel];
   add(id,channel==='email'?'gmail':'telegram-desktop-export',t+offset+delay+5,{source:trust,immutableId:id,account:recipient.account,sender:recipient.sender,peer:recipient.peer??null,recordedAt:at(t+offset+delay),monitorId:m.id,event:event.toUpperCase(),text:m.name+' '+event.toUpperCase()+' nonce '+nonce});
   if(channel==='email')ids.push(id);
  }
  add(m.service+'-owner-active','telegram-desktop-export',t+35,{source:trust,immutableId:m.service+'-owner',account:policy.owner.account,sender:policy.owner.identity,peer:policy.owner.peer,recordedAt:at(t+30),monitorId:m.id,event:'OWNER_ACTIVE',text:'Наблюдаю активный сбой '+m.name+'; операция '+binding.operationSha256+'; nonce '+nonce});
 });
 add('gmail-search-1','gmail',1114,{source:trust,query:bundle.gmailSearch.query,requestToken:null,nextPageToken:null,messageIds:ids});
 const observation={schema:'PHUB_TIMEWEB_CRITICAL_WEB_OBSERVATION_V1',startedAt:at(210),completedAt:at(1110),samples:Array.from({length:61},(_,i)=>({observedAt:at(210+i*15),api_private:100,api_public:120,web_private:80,web_public:90}))};
 add('direct-observation','reviewed-direct-probe-observation',1111,{source:'REVIEWED_DIRECT_PROBE_OBSERVATION',trust,target,binding,nonce},bytes(observation));
 const get=role=>bundle.captures.find(c=>c.role===role);
 const replaceRaw=(role,raw)=>{const c=get(role);files.set(c.rawFile,raw);c.rawSize=raw.length;c.rawSha256=hash(raw);};
 const seal=()=>{policy.captureReviewSha256=directRecipientCaptureReviewSha256(bundle.captures);const policyBytes=bytes(policy);bundle.policySha256=hash(policyBytes);return{policyBytes,bundleBytes:bytes(bundle),files,expected:{policySha256:hash(policyBytes),binding,nonce,reader:policy.reader},observedAt:at(1115)};};
 return {policy,bundle,files,get,replaceRaw,seal,observation,add};
}
`;
function scenario(code: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', fixture + code], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
}

describe('private direct/recipient preparation evidence', () => {
  it('binds both monitors, all channels and real owner roles without claiming provider history', () =>
    scenario(`const f=setup(); const result=buildDirectRecipientEvidence(f.seal());
      assert.equal(result.purpose,'PREPARATION_ONLY_NOT_FOR_ACTIVATION');assert.equal(result.operationalWriter,false);
      assert.equal(result.trust,trust);assert.equal(result.recipientLifecycle.length,2);for(const cycle of result.recipientLifecycle){assert.deepEqual(cycle.alerts.map(d=>d.channel),['email','telegram']);assert.deepEqual(cycle.recoveries.map(d=>d.channel),['email','telegram']);}assert.equal(result.directObservation.rounds,61);
      const text=JSON.stringify(result);for(const forbidden of ['recipient@example.test','notifier@example.test','monitor-bot','saved-messages','SYNTHETIC_ONLY','activeIncidentCount','successfulConsecutiveRounds','providerSha256','senderVerified'])assert.ok(!text.includes(forbidden));
    `));
  it('stops on UNENROLLED input instead of treating a policy as correlation proof', () =>
    scenario(
      `const f=setup();f.policy.state='UNENROLLED';const input=f.seal();const p=JSON.parse(input.policyBytes);p.captureReviewSha256=null;p.templates=null;input.policyBytes=bytes(p);input.expected.policySha256=hash(input.policyBytes);assert.throws(()=>buildDirectRecipientEvidence(input),/CORRELATION_CAPABILITY_UNPROVEN/);`,
    ));
  it.each([
    ['target', `f.policy.target.hostname='other.invalid'`],
    ['unknown field', `f.policy.extra=true`],
    ['source/tree', `f.policy.binding.sourceTree='invalid'`],
    ['release', `f.policy.binding.releaseId='b'.repeat(40)+'-123-1'`],
    ['nonce', `f.policy.nonce='short'`],
    ['owner role', `f.policy.owner.role='operator'`],
    ['owner account', `f.policy.owner.account='other-account'`],
    ['owner is notifier', `f.policy.owner.identity=f.policy.recipients.telegram.sender`],
    ['monitor configuration', `f.policy.configuration.monitors[0].intervalSeconds=120`],
    [
      'unknown template placeholder',
      `f.policy.templates.email.alert='{{monitorName}} {{nonce}} {{script}}'`,
    ],
    [
      'identical event templates',
      `f.policy.templates.email.alert=f.policy.templates.email.recovery`,
    ],
    ['one region', `f.policy.configuration.monitors[0].regions.pop()`],
    ['credential', `f.policy.recipients.email.sender='Bearer abcdefghijk'`],
  ])('rejects policy %s drift', (_, change) =>
    scenario(
      `const f=setup();${change};assert.throws(()=>parseDirectRecipientPolicy(bytes(f.policy)));`,
    ),
  );
  it.each([
    ['message sender', `f.get('api-email-alert').assertion.sender='attacker@example.test'`],
    ['mailbox', `f.get('api-email-alert').assertion.account='other@example.test'`],
    ['Telegram peer', `f.get('api-telegram-alert').assertion.peer='wrong'`],
    ['owner account context', `f.get('owner-account').assertion.account='other-account'`],
    ['owner peer context', `f.get('owner-account').assertion.peer='other-peer'`],
    [
      'observation operation',
      `f.get('direct-observation').assertion.binding={...binding,operationSha256:'f'.repeat(64)}`,
    ],
    ['observation target', `f.get('direct-observation').assertion.target={...target,serverId:1}`],
    ['observation nonce', `f.get('direct-observation').assertion.nonce='f'.repeat(32)`],
    [
      'observation collector',
      `f.get('direct-observation').assertion.binding={...binding,collectorSourceSha256:'f'.repeat(64)}`,
    ],
    ['owner author', `f.get('api-owner-active').assertion.sender='someone-else'`],
    [
      'owner text',
      `f.get('api-owner-active').assertion.text='Approved '+nonce+' lk2-beta-api-ready'`,
    ],
    [
      'wrong literal event template',
      `f.get('api-email-recovery').assertion.text='lk2-beta-api-ready ALERT nonce '+nonce`,
    ],
    ['missing nonce', `f.get('api-email-alert').assertion.text='lk2-beta-api-ready ALERT'`],
    ['repeated nonce', `f.get('api-email-alert').assertion.text+=nonce`],
    ['wrong monitor', `f.get('api-email-alert').assertion.monitorId=monitors[1].id`],
    ['message reuse', `f.get('api-email-recovery').assertion.immutableId='api-email-alert'`],
    ['future sent time', `f.get('api-email-alert').assertion.recordedAt=at(9999)`],
    ['late alert', `f.get('api-email-alert').capturedAt=at(301)`],
    ['owner before delivery', `f.get('api-owner-active').assertion.recordedAt=at(20)`],
    [
      'owner after recovery',
      `f.get('api-owner-active').assertion.recordedAt=at(60);f.get('api-owner-active').capturedAt=at(61)`,
    ],
    [
      'owner deadline',
      `f.get('api-owner-active').assertion.recordedAt=at(601);f.get('api-owner-active').capturedAt=at(602)`,
    ],
    ['late recovery', `f.get('api-email-recovery').capturedAt=at(361)`],
    ['recovery before transition', `f.get('api-email-recovery').assertion.recordedAt=at(59)`],
    ['different operation', `f.get('api-trigger').assertion.operationSha256='f'.repeat(64)`],
    ['fake provider history', `f.get('panel-configuration').assertion.activeIncidentCount=0`],
    ['stale final panel', `f.get('panel-configuration').capturedAt=at(-86401)`],
    [
      'raw credential',
      `f.replaceRaw('api-email-alert',Buffer.from('Authorization: Basic YWJjZGVmZ2hpamts'))`,
    ],
    [
      'short observation',
      `f.observation.completedAt=at(1109);f.replaceRaw('direct-observation',bytes(f.observation))`,
    ],
    [
      'bad cadence',
      `f.observation.samples[5].observedAt=at(306);f.replaceRaw('direct-observation',bytes(f.observation))`,
    ],
    [
      'p95',
      `for(const s of f.observation.samples)s.api_private=1501;f.replaceRaw('direct-observation',bytes(f.observation))`,
    ],
    [
      'probe failure',
      `f.observation.samples[1].web_public=-1;f.replaceRaw('direct-observation',bytes(f.observation))`,
    ],
    ['observation before recovery', `f.get('api-email-recovery').capturedAt=at(220)`],
    ['incomplete search', `f.get('gmail-search-1').assertion.nextPageToken='more'`],
    ['missing searched message', `f.get('gmail-search-1').assertion.messageIds.pop()`],
    ['ambiguous extra message', `f.get('gmail-search-1').assertion.messageIds.push('extra')`],
    ['search ID duplicate', `f.get('gmail-search-1').assertion.messageIds.push('api-email-alert')`],
    ['wrong search query', `f.bundle.gmailSearch.query='in:anywhere'`],
    [
      'shared export different bytes',
      `f.get('api-telegram-recovery').callId=f.get('api-telegram-alert').callId`,
    ],
    [
      'shared export different time',
      `const a=f.get('api-telegram-alert'),r=f.get('web-telegram-alert');r.callId=a.callId;f.replaceRaw(r.role,f.files.get(a.rawFile));r.capturedAt=at(26)`,
    ],
    [
      'shared export different version',
      `const a=f.get('api-telegram-alert'),r=f.get('web-telegram-alert');r.callId=a.callId;f.replaceRaw(r.role,f.files.get(a.rawFile));r.capturedAt=a.capturedAt;r.toolVersion='OTHER_VERSION'`,
    ],
    ['capture call reuse', `f.get('gmail-account').callId=f.get('panel-configuration').callId`],
    ['wrong reader', `f.get('api-email-alert').reader='another-reader'`],
  ])('rejects reviewed capture %s', (_, change) =>
    scenario(
      `const f=setup();${change};assert.throws(()=>buildDirectRecipientEvidence(f.seal()));`,
    ),
  );
  it('accepts complete pagination and rejects reused or missing page tokens', () =>
    scenario(
      `const f=setup();const first=f.get('gmail-search-1');const rest=first.assertion.messageIds.splice(2);first.assertion.nextPageToken='page-two';f.bundle.gmailSearch.pageRoles.push('gmail-search-2');const second=f.add('gmail-search-2','gmail',1114,{source:trust,query:f.bundle.gmailSearch.query,requestToken:'page-two',nextPageToken:null,messageIds:rest});buildDirectRecipientEvidence(f.seal());second.assertion.requestToken=null;assert.throws(()=>buildDirectRecipientEvidence(f.seal()),/SEARCH_CLOSURE/);`,
    ));
  it('reviews preserved captures later without changing their times or weakening delivery deadlines', () =>
    scenario(
      `const f=setup();const input=f.seal();const result=buildDirectRecipientEvidence({...input,observedAt:at(2000)});assert.equal(result.directObservation.completedAt,at(1110));assert.equal(result.recipientLifecycle[0].alerts[0].observedBy,at(15));`,
    ));
  it('accepts a later capture of the original active owner message', () =>
    scenario(
      `const f=setup();f.get('api-owner-active').capturedAt=at(200);const result=buildDirectRecipientEvidence(f.seal());assert.equal(result.recipientLifecycle[0].owner.acknowledgedAt,at(30));`,
    ));
  it('pins original bytes, review and expected operation independently', () =>
    scenario(`const f=setup();let input=f.seal();input.expected.policySha256='f'.repeat(64);assert.throws(()=>buildDirectRecipientEvidence(input),/POLICY_PIN/);
      input=f.seal();input.expected={...input.expected,binding:{...binding,operationSha256:'f'.repeat(64)}};assert.throws(()=>buildDirectRecipientEvidence(input),/EXPECTED_BINDING/);
      input=f.seal();input.files.set('raw/api-email-alert.bin',Buffer.from('tamper'));assert.throws(()=>buildDirectRecipientEvidence(input),/RAW_HASH/);
      const g=setup();input=g.seal();g.get('api-email-alert').assertion.sender='attacker@example.test';input.bundleBytes=bytes(g.bundle);assert.throws(()=>buildDirectRecipientEvidence(input),/REVIEW_HASH/);
    `));
  it('refuses missing/extra/oversized raw files and duplicate JSON keys', () =>
    scenario(`let f=setup();f.files.set('raw/foreign.bin',Buffer.from('private'));assert.throws(()=>buildDirectRecipientEvidence(f.seal()),/CLOSURE/);
      f=setup();f.bundle.captures.splice(0,1);assert.throws(()=>buildDirectRecipientEvidence(f.seal()),/CAPTURE_COUNT|CLOSURE/);
      f=setup();f.replaceRaw('api-email-alert',Buffer.alloc(2*1024*1024+1));assert.throws(()=>buildDirectRecipientEvidence(f.seal()),/CAPTURE/);
      f=setup();let input=f.seal();input.bundleBytes=Buffer.from(input.bundleBytes.toString().replace('"schema":','"schema":"duplicate","schema":'));assert.throws(()=>buildDirectRecipientEvidence(input),/JSON/);
    `));
  it('rejects stale or future observation and preserves original capture times', () =>
    scenario(
      `const f=setup();const input=f.seal();assert.throws(()=>buildDirectRecipientEvidence({...input,observedAt:at(86402)}),/CAPTURE_AGE/);assert.throws(()=>buildDirectRecipientEvidence({...input,observedAt:at(1000)}),/CAPTURE_AGE/);assert.equal(buildDirectRecipientEvidence(input).observedAt,at(1115));`,
    ));
  it('has no filesystem/network/CLI, adapter injection or controller enrollment', () => {
    const source = readFileSync('scripts/timeweb-direct-recipient-evidence.js', 'utf8');
    expect(source).not.toMatch(
      /node:(fs|child_process)|\bfetch\s*\(|process\.(argv|env)|import\s*\(|atomicWrite|readUpgradeMonitoring/,
    );
  });
});
