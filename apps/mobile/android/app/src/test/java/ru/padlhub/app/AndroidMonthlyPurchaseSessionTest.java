package ru.padlhub.app;
import org.junit.Test;
import static org.junit.Assert.*;
import static ru.padlhub.app.AndroidGameJoinSessionTest.*;
import static ru.padlhub.app.AndroidSessionPolicy.*;
import static ru.padlhub.app.AndroidSessionEngine.*;
import java.util.*;
import java.nio.charset.StandardCharsets;
public class AndroidMonthlyPurchaseSessionTest {
 static final String PATH=ROOT+"/subscription-purchase-operations";
 static final String CONSENT="{\"offerId\":\""+AndroidMonthlyPurchaseRequest.OFFER+"\",\"expectedRevision\":\"sha256:"+String.join("",Collections.nCopies(64,"a"))+"\",\"amountMinor\":100000,\"currency\":\"RUB\"}";
 @Test public void sixResourcesPreserveOriginalConsentAndKey()throws Exception{
  List<Request> sent=new ArrayList<>();AndroidSessionEngine e=new AndroidSessionEngine(policy(),new MemoryStore(),r->{sent.add(r);return new Response(200,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});
  Map<String,String> read=headers();read.remove("idempotency-key");e.request(PATH+"/capability","GET",read,null);
  e.request(PATH+"/quote","POST",headers(),"{\"offerId\":\""+AndroidMonthlyPurchaseRequest.OFFER+"\"}");e.request(PATH,"POST",headers(),CONSENT);e.request(PATH+"/by-key","GET",headers(),null);
  e.request(PATH+"/"+KEY+"/reconcile","POST",headers(),"{}");e.request(PATH+"/"+KEY+"/payment-launch","POST",headers(),"{}");
  assertEquals(6,sent.size());assertEquals(CONSENT,new String(sent.get(2).body,StandardCharsets.UTF_8));assertEquals(KEY,sent.get(5).headers.get("idempotency-key"));
 }
 @Test public void deniesAlternateBodyAndProviderTargets()throws Exception{
  for(String body:Arrays.asList("{}",CONSENT.replace("100000","0"),CONSENT.replace("100000","true"),CONSENT.replace("100000","1.5"),CONSENT.replace("}",",\"clientId\":\"provider\"}"),CONSENT.replace("}",",\"amountMinor\":1}")))rejected(()->policy().request(PATH,"POST",headers(),body));
  for(String suffix:Arrays.asList("?clientId=x","/../games","/unknown","/"+KEY+"/reconcile?key=x"))rejected(()->policy().request(PATH+suffix,"POST",headers(),CONSENT));
 }
 @Test public void httpAndNetworkNeverRetryPayment()throws Exception{
  for(int status:new int[]{401,503,0}){List<Request> sent=new ArrayList<>();AndroidSessionEngine e=new AndroidSessionEngine(policy(),new MemoryStore(),r->{sent.add(r);if(status==0)throw new Failure("NATIVE_NETWORK_UNAVAILABLE");return new Response(status,Collections.emptyMap(),Collections.emptyList(),"{}".getBytes(StandardCharsets.UTF_8));});try{assertEquals(status,e.request(PATH,"POST",headers(),CONSENT).status);}catch(Failure x){assertEquals(0,status);}assertEquals(1,sent.size());}
 }
 @Test public void missingSessionAndPendingLogoutNeverDispatch()throws Exception{
  MemoryStore store=new MemoryStore();store.value=store.value.journal(null,KEY);List<Request> sent=new ArrayList<>();AndroidSessionEngine e=new AndroidSessionEngine(policy(),store,r->{sent.add(r);throw new Failure("UNEXPECTED");});assertEquals(401,e.request(PATH,"POST",headers(),CONSENT).status);store.clear();assertEquals(401,e.request(PATH,"POST",headers(),CONSENT).status);assertEquals(0,sent.size());
 }
 @Test public void bankLaunchOnlyBuildsFixedPadlHubFragment()throws Exception{
  String code=GAME+"."+String.join("",Collections.nCopies(64,"a"));assertEquals("https://lk2.padlhub.su/user/api/v1/subscription-payment-launch#operationId="+KEY+"&launchCode="+code,AndroidMonthlyPurchaseRequest.launchUrl("https://lk2.padlhub.su",KEY,code));
  for(String bad:Arrays.asList(code+"\n",code+"&url=https://foreign.invalid","https://bank.example/pay"))rejected(()->AndroidMonthlyPurchaseRequest.launchUrl("https://lk2.padlhub.su",KEY,bad));
 }
}
