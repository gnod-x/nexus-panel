import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/app.js";
import { Store } from "../../src/server/db.js";
import { hashPassword } from "../../src/server/security.js";

describe("optional username login maps one existing account", () => {
 const keys = ["LOGIN_USERNAME", "LOGIN_USER_ID", "PUBLIC_ORIGIN", "NODE_ENV"] as const;
 let saved: Record<string, string | undefined>;
 let store: Store;
 const apps: ReturnType<typeof buildApp>[] = [];
 beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => { delete process.env[key]; });
  process.env.NODE_ENV = "test";
  store = new Store(":memory:");
 });
 afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  store.db.close();
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
 });
 function appFor(username?: string, id?: string) {
  if (username === undefined) delete process.env.LOGIN_USERNAME; else process.env.LOGIN_USERNAME = username;
  if (id === undefined) delete process.env.LOGIN_USER_ID; else process.env.LOGIN_USER_ID = id;
  const app = buildApp(store); apps.push(app); return app;
 }
 function login(app: ReturnType<typeof buildApp>, email: string, password = "123456", headers: Record<string,string> = {}) {
  return app.inject({method:"POST",url:"/api/auth/login",headers:{"content-type":"application/json",...headers},payload:{email,password}});
 }
 it("defaults to email-only validation and does not advertise username mode", async () => {
  store.createUser("existing@example.test",hashPassword("123456"));
  const app=appFor();
  expect((await app.inject({method:"GET",url:"/api/auth/status"})).json()).toEqual({bootstrapped:true});
  const result=await login(app,"123456");
  expect(result.statusCode).toBe(400); expect(result.json()).toEqual({error:"invalid_input"});
  expect((await login(app,"existing@example.test")).statusCode).toBe(200);
 });
 it("maps the configured alias to the existing user's session and role without provisioning", async () => {
  const target=store.createUser("existing@example.test",hashPassword("123456"),"viewer");
  const app=appFor("123456",String(target.id));
  const status=(await app.inject({method:"GET",url:"/api/auth/status"})).json();
  expect(status).toEqual({bootstrapped:true,usernameLoginEnabled:true});
  const result=await login(app,"123456");
  expect(result.statusCode).toBe(200); expect(result.json().user).toMatchObject({id:target.id,email:target.email,role:"viewer"});
  expect(JSON.stringify(result.json())).not.toContain("passwordHash");
  const raw=result.headers["set-cookie"]; const cookie=(Array.isArray(raw)?raw[0]:raw||"").split(";")[0];
  const me=await app.inject({method:"GET",url:"/api/auth/me",headers:{cookie}});
  expect(me.statusCode).toBe(200);expect(me.json().user.id).toBe(target.id);
  const blocked=await app.inject({method:"POST",url:"/api/groups",headers:{"content-type":"application/json",cookie},payload:{name:"not allowed",slug:"not-allowed"}});
  expect(blocked.statusCode).toBe(403);expect(store.userCount()).toBe(1);
 });
 it("returns identical credential failures for wrong password or a different username", async () => {
  const user=store.createUser("existing@example.test",hashPassword("123456"));
  const app=appFor("123456",String(user.id));
  for (const [name,password] of [["123456","wrong"],["654321","123456"]]) {
   const result=await login(app,name,password);
   expect(result.statusCode).toBe(401); expect(result.json()).toEqual({error:"invalid_credentials"});
  }
 });
 it("fails closed when the configured target does not exist and does not create it", async () => {
  store.createUser("existing@example.test",hashPassword("123456"));
  const app=appFor("123456","999");
  const result=await login(app,"123456");
  expect(result.statusCode).toBe(401);expect(result.json()).toEqual({error:"invalid_credentials"});
  expect(store.userCount()).toBe(1);
  expect((await login(app,"existing@example.test")).statusCode).toBe(200);
 });
 it("keeps normalized email login and exact password semantics with username mode enabled", async () => {
  const user=store.createUser("existing@example.test",hashPassword(" 123456 "));
  const app=appFor("123456",String(user.id));
  expect((await login(app," existing＠example。test "," 123456 ")).statusCode).toBe(200);
  expect((await login(app,"123456"," 123456 ")).statusCode).toBe(200);
  expect((await login(app,"123456","123456")).statusCode).toBe(401);
 });
 it("does not accept malformed usernames or non-string identifiers", async () => {
  const user=store.createUser("existing@example.test",hashPassword("123456"));
  const app=appFor("123456",String(user.id));
  for (const email of ["bad account","<script>","a/b",123456,null]) {
   const result=await app.inject({method:"POST",url:"/api/auth/login",headers:{"content-type":"application/json"},payload:{email,password:"123456"}});
   expect(result.statusCode).toBe(400);
  }
 });
 it.each([["123456",undefined],[undefined,"1"],["bad alias","1"],["123456","0"],["123456","1.5"]])("fails startup for invalid or incomplete alias configuration %s/%s",(username,id)=>{
  expect(()=>appFor(username,id)).toThrow();
 });
 it("does not relax bootstrap email or twelve-character password requirements", async () => {
  const app=appFor("123456","1");
  for (const credentials of [{email:"123456",password:"long synthetic phrase"},{email:"valid@example.test",password:"123456"}]) {
   const result=await app.inject({method:"POST",url:"/api/auth/bootstrap",headers:{"content-type":"application/json"},payload:credentials});
   expect(result.statusCode).toBe(400);
  }
  expect(store.userCount()).toBe(0);
 });
 it("keeps exact public-origin checks and secure cookies for alias authentication", async () => {
  const user=store.createUser("existing@example.test",hashPassword("123456"));
  process.env.NODE_ENV="production";process.env.PUBLIC_ORIGIN="https://preview.example.test";
  const app=appFor("123456",String(user.id));
  const denied=await login(app,"123456","123456",{host:"127.0.0.1:3000",origin:"https://other.example.test","x-forwarded-host":"preview.example.test"});
  expect(denied.statusCode).toBe(403);expect(denied.json()).toEqual({error:"origin_forbidden"});
  const accepted=await login(app,"123456","123456",{host:"127.0.0.1:3000",origin:"https://preview.example.test"});
  expect(accepted.statusCode).toBe(200);
  const raw=accepted.headers["set-cookie"];const cookie=Array.isArray(raw)?raw[0]:raw||"";
  expect(cookie.toLowerCase()).toContain("secure");expect(cookie.toLowerCase()).toContain("httponly");
 });
});
