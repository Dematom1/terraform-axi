import { recordSession } from "../src/sessions.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => { input += chunk; });
process.stdin.on("end", () => {
  try { recordSession(JSON.parse(input)); } catch { /* Invalid hook input is ignored. */ }
});
