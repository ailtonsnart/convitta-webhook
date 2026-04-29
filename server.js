const express     = require('express');
const admin       = require('firebase-admin');

const app  = express();
app.use(express.json());

// ─── Firebase Admin — usa a Service Account do env ───────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ─── Health check (mantém o servidor acordado) ────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'convitta-webhook' }));

// ─── Webhook da InfinitePay ───────────────────────────────────────────────────
app.post('/webhook/infinitepay', async (req, res) => {
  try {
    const body   = req.body;
    const isPaid = body.paid === true
      || body.status === 'paid'
      || body.status === 'approved'
      || body.status === 'succeeded';

    if (!isPaid) {
      return res.status(200).json({ received: true, paid: false });
    }

    // InfinitePay envia o order_nsu que gravamos no Firestore ao criar a cobrança
    const orderNsu = body.order_nsu || body.orderNsu || '';
    if (!orderNsu) {
      return res.status(400).json({ error: 'order_nsu ausente' });
    }

    // Busca o convite pelo orderNsu
    const snap = await db.collection('invites')
      .where('payment.orderNsu', '==', orderNsu)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn('Webhook: convite não encontrado para orderNsu:', orderNsu);
      return res.status(404).json({ error: 'Convite não encontrado' });
    }

    await snap.docs[0].ref.update({
      paid:      true,
      updatedAt: new Date().toISOString(),
    });

    console.log('✓ Pagamento confirmado:', orderNsu);
    return res.status(200).json({ received: true, paid: true });

  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Cria cobrança InfinitePay (chamado pelo frontend via fetch) ──────────────
app.post('/criar-cobranca', async (req, res) => {
  // CORS — permite só o domínio do site
  res.setHeader('Access-Control-Allow-Origin', 'https://convitta-4df80.web.app');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(204);

  try {
    const { inviteCode, modelMode, modelName } = req.body;
    if (!inviteCode || !modelMode) {
      return res.status(400).json({ error: 'Parâmetros inválidos' });
    }

    const inviteRef  = db.collection('invites').doc(inviteCode);
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) return res.status(404).json({ error: 'Convite não encontrado' });
    if (inviteSnap.data().paid) return res.json({ alreadyPaid: true });

    const priceCents  = modelMode === 'premium' ? 999 : 499;
    const orderNsu    = `CONV-${inviteCode}-${Date.now()}`;
    const redirectUrl = `https://convitta-4df80.web.app?paid=1&code=${encodeURIComponent(inviteCode)}`;
    const webhookUrl  = `${process.env.RENDER_URL}/webhook/infinitepay`;

    const payload = {
      handle:        'ailton_pay',
      order_nsu:     orderNsu,
      payment_types: ['pix'],
      redirect_url:  redirectUrl,
      webhook_url:   webhookUrl,
      items: [{
        quantity:    1,
        price:       priceCents,
        description: `Convitta - Modelo ${modelName || (modelMode === 'premium' ? 'Premium' : 'Padrao')}`,
      }],
    };

    const resp = await fetch('https://api.infinitepay.io/invoices/public/checkout/links', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('InfinitePay error:', resp.status, err);
      return res.status(502).json({ error: 'Erro InfinitePay: ' + resp.status });
    }

    const data = await resp.json();

    // Salva orderNsu no Firestore para o webhook encontrar
    await inviteRef.update({
      'payment.orderNsu':    orderNsu,
      'payment.invoiceSlug': data.invoice_slug || data.slug || '',
      'payment.checkoutUrl': data.checkout_url || data.url || '',
      updatedAt: new Date().toISOString(),
    });

    return res.json({
      checkoutUrl: data.checkout_url || data.url || '',
      orderNsu,
    });

  } catch (err) {
    console.error('Erro ao criar cobrança:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// Preflight CORS para /criar-cobranca
app.options('/criar-cobranca', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://convitta-4df80.web.app');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(204);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Convitta webhook rodando na porta ${PORT}`));
