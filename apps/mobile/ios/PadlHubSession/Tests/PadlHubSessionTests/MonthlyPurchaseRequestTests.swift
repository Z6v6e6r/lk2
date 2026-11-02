import Foundation
import XCTest
@testable import PadlHubSession
private final class MonthlyMemoryStore:CredentialStore {
 var value:RefreshCredential?
 func read()throws->RefreshCredential?{value}
 func write(_ value:RefreshCredential)throws{self.value=value}
 func clear()throws{value=nil}
}
final class MonthlyPurchaseRequestTests:XCTestCase {
 let id="11111111-1111-4111-8111-111111111111",key="monthly:22222222-2222-4222-8222-222222222222"
 let offer="862670f6-a476-4a18-aecb-9e27661fbad3"
 func config()throws->SessionConfiguration{try SessionConfiguration(origin:"https://lk2.padlhub.su",tenant:"synthetic",appVersion:"test",appBuild:"1")}
 var headers:[String:String]{["Authorization":"Bearer synthetic-access","Idempotency-Key":key]}
 var body:String{"{\"offerId\":\"\(offer)\",\"expectedRevision\":\"sha256:\(String(repeating:"a",count:64))\",\"amountMinor\":100000,\"currency\":\"RUB\"}"}
 func command()->SessionRequest{SessionRequest(operation:.monthlyPurchase,headers:headers,body:body,monthlyPurchase:MonthlyPurchaseRequest(resource:"purchase"))}
 func testSixClosedResourcesAndOriginalKey()throws{
  let cap=try SessionRequest(operation:.monthlyPurchase,headers:["Authorization":"Bearer synthetic-access"],monthlyPurchase:MonthlyPurchaseRequest(resource:"capability")).urlRequest(configuration:config());XCTAssertEqual(cap.httpMethod,"GET");XCTAssertNil(cap.httpBody)
  let read=try SessionRequest(operation:.monthlyPurchase,headers:headers,monthlyPurchase:MonthlyPurchaseRequest(resource:"byKey")).urlRequest(configuration:config());XCTAssertEqual(read.url?.path,"/user/api/v1/synthetic/subscription-purchase-operations/by-key")
  let quote=try SessionRequest(operation:.monthlyPurchase,headers:headers,body:"{\"offerId\":\"\(offer)\"}",monthlyPurchase:MonthlyPurchaseRequest(resource:"quote")).urlRequest(configuration:config());XCTAssertEqual(quote.httpMethod,"POST")
  let purchase=try command().urlRequest(configuration:config());XCTAssertEqual(purchase.httpBody,Data(body.utf8));XCTAssertEqual(purchase.value(forHTTPHeaderField:"Idempotency-Key"),key)
  for resource in ["reconcile","launch"]{let r=try SessionRequest(operation:.monthlyPurchase,headers:headers,body:"{}",monthlyPurchase:MonthlyPurchaseRequest(resource:resource,operationID:id)).urlRequest(configuration:config());XCTAssertEqual(r.httpMethod,"POST");XCTAssertEqual(r.value(forHTTPHeaderField:"Idempotency-Key"),key)}
 }
 func testRejectsAlternateConsentAndMixedOperations()throws{
  for invalid in ["{}",body.replacingOccurrences(of:"100000",with:"0"),body.replacingOccurrences(of:"100000",with:"true"),body.replacingOccurrences(of:"100000",with:"1.5"),body.replacingOccurrences(of:"}",with:",\"amountMinor\":1}"),body.replacingOccurrences(of:"}",with:",\"clientId\":\"provider\"}")]{XCTAssertThrowsError(try SessionRequest(operation:.monthlyPurchase,headers:headers,body:invalid,monthlyPurchase:MonthlyPurchaseRequest(resource:"purchase")).urlRequest(configuration:config()))}
  XCTAssertThrowsError(try SessionRequest(operation:.read,headers:headers,read:CabinetRead(resource:.home),monthlyPurchase:MonthlyPurchaseRequest(resource:"byKey")).urlRequest(configuration:config()))
  XCTAssertThrowsError(try SessionRequest(operation:.monthlyPurchase,headers:headers,read:CabinetRead(resource:.home),monthlyPurchase:MonthlyPurchaseRequest(resource:"byKey")).urlRequest(configuration:config()))
 }
 func testLostHTTPOrNetworkNeverRepeatsPurchase()async throws{
  for status in [401,503,0]{let store=MonthlyMemoryStore();store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600));var sent=0
   let transport=SessionTransport(configuration:try config(),store:store){request in sent+=1;if status==0{throw SessionFailure.network};return(Data("{}".utf8),HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:[:])!)}
   do{let r=try await transport.request(command());XCTAssertEqual(r.status,status)}catch{XCTAssertEqual(status,0)};XCTAssertEqual(sent,1)
  }
 }
 func testLogoutAndMissingCredentialNeverSend()async throws{
  let store=MonthlyMemoryStore();var sent=0;let transport=SessionTransport(configuration:try config(),store:store){_ in sent+=1;throw SessionFailure.network}
  let absent=try await transport.request(command());XCTAssertEqual(absent.status,401)
  store.value=RefreshCredential(version:1,scope:try config().keychainScope,value:String(repeating:"s",count:40),expiresAt:Date().addingTimeInterval(3600),logoutKey:key)
  let pending=try await transport.request(command());XCTAssertEqual(pending.status,401);XCTAssertEqual(sent,0)
 }
 func testLaunchUsesFixedOriginAndFragmentOnly()throws{
  let code=id+"."+String(repeating:"a",count:64),url=try MonthlyPurchaseRequest.launchURL(configuration:config(),operationID:id,launchCode:id+"."+String(repeating:"a",count:64))
  XCTAssertEqual(url.host,"lk2.padlhub.su");XCTAssertEqual(url.path,"/user/api/v1/subscription-payment-launch");XCTAssertNil(url.query);XCTAssertEqual(url.fragment,"operationId=\(id)&launchCode=\(code)")
  for bad in [code+"\n",code+"&url=other","https://bank.example/pay"]{XCTAssertThrowsError(try MonthlyPurchaseRequest.launchURL(configuration:config(),operationID:id,launchCode:bad))}
 }
}
