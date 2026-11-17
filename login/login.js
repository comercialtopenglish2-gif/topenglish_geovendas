(function () {
  var f = document.getElementById("f"), msg = document.getElementById("msg"), btn = document.getElementById("entrar");
  var next = new URLSearchParams(location.search).get("next") || "/";
  function aviso(t) { msg.textContent = t; msg.hidden = !t; }
  f.addEventListener("submit", async function (e) {
    e.preventDefault(); aviso("");
    var email = f.email.value.trim(), senha = f.password.value;
    if (!email || !senha) { aviso("Informe e-mail e senha."); return; }
    btn.disabled = true; btn.textContent = "Entrando…";
    try {
      var r = await fetch("/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: senha, next: next }) });
      var j = {}; try { j = await r.json(); } catch (x) {}
      if (r.ok && j.ok) { location.replace(j.next || "/"); return; }
      aviso(j.message || "Não foi possível entrar agora.");
    } catch (x) { aviso("Sem conexão. Tente de novo."); }
    f.password.value = ""; btn.disabled = false; btn.textContent = "Entrar";
  });
})();
