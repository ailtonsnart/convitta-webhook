# Deploy do Servidor Webhook no Render

## PASSO 1 — Gerar a Service Account do Firebase

1. Acesse: https://console.firebase.google.com/project/convitta-4df80/settings/serviceaccounts/adminsdk
2. Clique em **"Gerar nova chave privada"**
3. Confirme — vai baixar um arquivo `.json`
4. **Guarde esse arquivo** — precisaremos do conteúdo dele no Passo 3

---

## PASSO 2 — Subir o código no GitHub

1. Crie um repositório novo no GitHub chamado `convitta-webhook` (privado)
2. Faça upload de todos os arquivos desta pasta:
   - `server.js`
   - `package.json`
   - `.gitignore`

---

## PASSO 3 — Criar o serviço no Render

1. Acesse: https://render.com e faça login
2. Clique em **"New +"** → **"Web Service"**
3. Conecte seu repositório `convitta-webhook` do GitHub
4. Configure:
   - **Name:** `convitta-webhook`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`
5. Clique em **"Advanced"** → **"Add Environment Variable"** e adicione:

   | Key | Value |
   |-----|-------|
   | `FIREBASE_SERVICE_ACCOUNT` | Cole TODO o conteúdo do arquivo `.json` baixado no Passo 1 (numa única linha) |
   | `RENDER_URL` | `https://convitta-webhook.onrender.com` |

6. Clique em **"Create Web Service"**
7. Aguarde o deploy terminar (~2 min)
8. Confirme que aparece **"Live"** verde no topo

---

## PASSO 4 — Registrar webhook na InfinitePay

1. Acesse: https://app.infinitepay.io
2. Vá em **Checkout → Configurações → Webhooks**
3. Adicione a URL:
   ```
   https://convitta-webhook.onrender.com/webhook/infinitepay
   ```
4. Salve

---

## PASSO 5 — Deploy do site

```bash
firebase deploy --only hosting
```

---

## VERIFICAR SE ESTÁ FUNCIONANDO

Abra no navegador:
```
https://convitta-webhook.onrender.com
```
Deve aparecer: `{"status":"ok","service":"convitta-webhook"}`

---

## FLUXO COMPLETO APÓS DEPLOY

```
1. Usuário clica "Pagar com PIX"
2. Site chama Render → Render cria cobrança na InfinitePay
3. QR Code PIX aparece na página da InfinitePay
4. Usuário escaneia com o APP DO BANCO e paga ✓
5. InfinitePay chama webhook no Render
6. Render grava paid:true no Firestore
7. Site detecta via onSnapshot → link liberado automaticamente ✓
```
