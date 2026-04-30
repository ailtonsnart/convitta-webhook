const express = require('express');
const admin   = require('firebase-admin');

const app = express();
app.use(express.json());

// ─── Firebase Admin ───────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const CORS_ORIGIN = 'https://convitta-4df80.web.app';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'convitta-webhook' }));

// ─── Preflight CORS ───────────────────────────────────────────────────────────
app.options('*', (req, res) => { setCors(res); res.sendStatus(204); });

// ─── Webhook InfinitePay — confirma pagamento e grava no Firestore ─────────────
app.post('/webhook/infinitepay', async (req, res) => {
  try {
    const body   = req.body;
    const isPaid = body.paid === true
      || body.status === 'paid'
      || body.status === 'approved'
      || body.status === 'succeeded';

    if (!isPaid) return res.status(200).json({ received: true, paid: false });

    const orderNsu = body.order_nsu || body.orderNsu || '';
    if (!orderNsu) return res.status(400).json({ error: 'order_nsu ausente' });

    const snap = await db.collection('invites')
      .where('payment.orderNsu', '==', orderNsu).limit(1).get();

    if (snap.empty) {
      console.warn('Webhook: convite não encontrado:', orderNsu);
      return res.status(404).json({ error: 'Convite não encontrado' });
    }

    await snap.docs[0].ref.update({ paid: true, updatedAt: new Date().toISOString() });
    console.log('✓ Pagamento confirmado:', orderNsu);
    return res.status(200).json({ received: true, paid: true });

  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Cria cobrança e extrai QR Code + Copia e Cola da InfinitePay ─────────────
app.post('/criar-cobranca', async (req, res) => {
  setCors(res);
  try {
    const { inviteCode, modelMode, modelName } = req.body;
    if (!inviteCode || !modelMode) {
      return res.status(400).json({ error: 'Parâmetros inválidos' });
    }

    const inviteRef  = db.collection('invites').doc(inviteCode);
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) return res.status(404).json({ error: 'Convite não encontrado' });
    if (inviteSnap.data().paid) return res.json({ alreadyPaid: true });

    const priceCents = modelMode === 'premium' ? 999 : 499;
    const orderNsu   = `CONV-${inviteCode}-${Date.now()}`;
    const webhookUrl = `${process.env.RENDER_URL}/webhook/infinitepay`;

    const payload = {
      handle:        'ailton_pay',
      order_nsu:     orderNsu,
      payment_types: ['pix'],
      webhook_url:   webhookUrl,
      redirect_url:  `${CORS_ORIGIN}?paid=1&code=${encodeURIComponent(inviteCode)}`,
      items: [{
        quantity:    1,
        price:       priceCents,
        description: `Convitta - Modelo ${modelName || (modelMode === 'premium' ? 'Premium' : 'Padrao')}`,
      }],
    };

    // 1. Cria o link de checkout na InfinitePay
    const linkResp = await fetch('https://api.infinitepay.io/invoices/public/checkout/links', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!linkResp.ok) {
      const err = await linkResp.text();
      console.error('InfinitePay error:', linkResp.status, err);
      return res.status(502).json({ error: 'Erro ao criar cobrança: ' + linkResp.status });
    }

    const linkData    = await linkResp.json();
    const checkoutUrl = linkData.checkout_url || linkData.url || '';
    const slug        = linkData.invoice_slug || linkData.slug || '';

    console.log('Checkout criado:', checkoutUrl);

    // 2. Busca a página de checkout para extrair o PIX Copia e Cola
    let pixCopiaECola = '';
    let pixQrCodeImg  = '';

    try {
      const pageResp = await fetch(checkoutUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Convitta/1.0)' }
      });
      const html = await pageResp.text();

      // Tenta extrair o Copia e Cola do HTML (padrões comuns)
      const patterns = [
        /"pix_copy_paste"\s*:\s*"([^"]+)"/,
        /"copyPaste"\s*:\s*"([^"]+)"/,
        /"copy_paste"\s*:\s*"([^"]+)"/,
        /"brcode"\s*:\s*"([^"]+)"/,
        /"emv"\s*:\s*"([^"]+)"/,
        /"pixCode"\s*:\s*"([^"]+)"/,
        /"pix_code"\s*:\s*"([^"]+)"/,
        /data-pix="([^"]+)"/,
        /data-copy="(00020[^"]+)"/,
        /value="(00020[^"]+)"/,
        /(00020101[a-zA-Z0-9]{20,})/,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1] && match[1].startsWith('00020')) {
          pixCopiaECola = match[1];
          break;
        }
      }

      // Tenta extrair imagem do QR Code
      const qrPatterns = [
        /"qr_code_base64"\s*:\s*"([^"]+)"/,
        /"qrCodeBase64"\s*:\s*"([^"]+)"/,
        /"qr_image"\s*:\s*"([^"]+)"/,
        /src="(data:image\/png;base64,[^"]+)"/,
      ];
      for (const pattern of qrPatterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          pixQrCodeImg = match[1].startsWith('data:') ? match[1] : `data:image/png;base64,${match[1]}`;
          break;
        }
      }

      if (pixCopiaECola) {
        console.log('✓ Copia e Cola extraído, tamanho:', pixCopiaECola.length);
      } else {
        console.warn('Copia e Cola não encontrado no HTML — retornando checkout URL');
      }

    } catch (pageErr) {
      console.warn('Erro ao buscar página de checkout:', pageErr.message);
    }

    // 3. Salva no Firestore
    await inviteRef.update({
      'payment.orderNsu':    orderNsu,
      'payment.invoiceSlug': slug,
      'payment.checkoutUrl': checkoutUrl,
      updatedAt: new Date().toISOString(),
    });

    return res.json({
      orderNsu,
      checkoutUrl,
      pixCopiaECola,   // string EMV para gerar QR Code e copia e cola
      pixQrCodeImg,    // imagem base64 se disponível
    });

  } catch (err) {
    console.error('Erro ao criar cobrança:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Convitta webhook rodando na porta ${PORT}`));
