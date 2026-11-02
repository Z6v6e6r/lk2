package ru.padlhub.app;
import java.util.*;
import org.json.JSONObject;
/** Fixed monthly purchase commands. Provider URL and identity are never caller inputs. */
final class AndroidMonthlyPurchaseRequest {
  static final String UUID="[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  static final String OFFER="862670f6-a476-4a18-aecb-9e27661fbad3";
  static void validate(String path,String query,String method,Map<String,String> headers,String body) throws AndroidSessionPolicy.Failure {
    if(query!=null) throw AndroidSessionPolicy.rejected();
    String root="/subscription-purchase-operations";
    boolean capability=path.equals(root+"/capability")&&"GET".equals(method);
    boolean read=capability||(path.equals(root+"/by-key")&&"GET".equals(method));
    boolean quote=path.equals(root+"/quote")&&"POST".equals(method);
    boolean purchase=path.equals(root)&&"POST".equals(method);
    boolean recover=path.matches(root+"/"+UUID+"/(reconcile|payment-launch)")&&"POST".equals(method);
    if(!read&&!quote&&!purchase&&!recover) throw AndroidSessionPolicy.rejected();
    if(capability?headers.containsKey("idempotency-key"):!headers.getOrDefault("idempotency-key","").matches("[A-Za-z0-9._:-]{16,128}")) throw AndroidSessionPolicy.rejected();
    if(read){if(body!=null)throw AndroidSessionPolicy.rejected();return;}
    try {
      if(body==null||body.length()>1024||(headers.containsKey("content-type")&&!"application/json".equalsIgnoreCase(headers.get("content-type"))))throw AndroidSessionPolicy.rejected();
      String field="\"(?:offerId|expectedRevision|amountMinor|currency)\"\\s*:\\s*(?:\"[A-Za-z0-9:-]+\"|[0-9]+)";
      int count=quote?1:purchase?4:0;
      String pattern=count==0?"\\s*\\{\\s*\\}\\s*":"\\s*\\{\\s*"+field+"(?:\\s*,\\s*"+field+"){"+(count-1)+"}\\s*\\}\\s*";
      if(!body.matches(pattern))throw AndroidSessionPolicy.rejected();
      JSONObject b=new JSONObject(body);if(b.length()!=count)throw AndroidSessionPolicy.rejected();
      if(count>0&&!OFFER.equals(b.get("offerId")))throw AndroidSessionPolicy.rejected();
      if(purchase){
        if(!"RUB".equals(b.get("currency"))||!(b.get("expectedRevision") instanceof String)||!b.getString("expectedRevision").matches("sha256:[0-9a-f]{64}")||!(b.get("amountMinor") instanceof Number))throw AndroidSessionPolicy.rejected();
        double amount=b.getDouble("amountMinor");if(amount<1||amount>100000000||amount!=Math.floor(amount))throw AndroidSessionPolicy.rejected();
      }
    }catch(AndroidSessionPolicy.Failure e){throw e;}catch(Exception e){throw AndroidSessionPolicy.rejected();}
  }
  static String launchUrl(String origin,String operationId,String launchCode)throws AndroidSessionPolicy.Failure {
    if(operationId==null||!operationId.matches(UUID)||launchCode==null||!launchCode.matches(UUID+"\\.[0-9a-f]{64}"))throw AndroidSessionPolicy.rejected();
    return origin+"/user/api/v1/subscription-payment-launch#operationId="+operationId+"&launchCode="+launchCode;
  }
}
