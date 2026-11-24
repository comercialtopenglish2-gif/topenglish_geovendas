// API da Anthropic FALSA, só para testes locais do streaming (SSE). Não vai para produção.
import http from "node:http";
const PORT = Number(process.env.MOCK_AI_PORT || 4100);
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", async () => {
    const corpo = JSON.parse(b || "{}");
    const ult = corpo.messages[corpo.messages.length - 1];
    const temImagem = Array.isArray(ult.content) && ult.content.some(x => x.type === "image");
    const txt = typeof ult.content === "string" ? ult.content : ult.content.filter(x => x.type === "text").map(x => x.text).join("");
    let resposta = /SOMENTE com um JSON/.test(txt) ? '```json\n{"ok":true,"modelo":"' + corpo.model + '"}\n```'
      : "## Resposta de teste\nModelo " + corpo.model + (temImagem ? " · recebi imagem" : "") + " · mensagens " + corpo.messages.length + ". Fala com Caroline Neves.";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const ev = (o) => res.write("event: " + o.type + "\ndata: " + JSON.stringify(o) + "\n\n");
    ev({ type: "message_start", message: { usage: { input_tokens: Math.ceil(JSON.stringify(corpo.messages).length / 4) } } }); // aproximação para testar o custo
    for (const pedaco of resposta.match(/.{1,12}/gs)) { ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: pedaco } }); await new Promise(r => setTimeout(r, 30)); }
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: Math.ceil(resposta.length / 4) } });
    ev({ type: "message_stop" }); res.end();
  });
}).listen(PORT, () => console.log("Anthropic falsa em " + PORT));
