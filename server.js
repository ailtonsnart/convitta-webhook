const express = require('express');
const admin   = require('firebase-admin');

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const MP_TOKEN    = process.env.MP_ACCESS_TOKEN;
const MP_API      = 'https://api.mercadopago.com';
const CORS_ORIGIN = 'https://convitta-4df80.web.app';
const RENDER_URL  = process.env.RENDER_URL || 'https://convitta-webhook.onrender.com';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'convitta-webhook' }));
app.options('*', (req, res) => { setCors(res); res.sendStatus(204); });

// ─── Cria cobrança PIX e retorna QR Code + link de pagamento ──────────────────
app.post('/criar-cobranca', async (req, res) => {
  setCors(res);
  try {
    const { inviteCode, modelMode, modelName } = req.body;
    if (!inviteCode || !modelMode) return res.status(400).json({ error: 'Parametros invalidos' });

    const inviteRef  = db.collection('invites').doc(inviteCode);
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) return res.status(404).json({ error: 'Convite nao encontrado' });
    if (inviteSnap.data().paid) return res.json({ alreadyPaid: true });

    const amount = modelMode === 'premium' ? 9.99 : 4.99;
    const desc   = 'Convitta - Modelo ' + (modelName || (modelMode === 'premium' ? 'Premium' : 'Padrao'));

    // Cria pagamento PIX via API de Pagamentos (retorna QR Code imagem)
    const mpResp = await fetch(MP_API + '/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'Authorization':     'Bearer ' + MP_TOKEN,
        'X-Idempotency-Key': inviteCode + '-' + Date.now(),
      },
      body: JSON.stringify({
        transaction_amount: amount,
        description:        desc,
        payment_method_id:  'pix',
        notification_url:   RENDER_URL + '/webhook/mercadopago',
        date_of_expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        payer:              { email: 'pagador@convitta.app' },
        metadata:           { invite_code: inviteCode },
      }),
    });

    if (!mpResp.ok) {
      const err = await mpResp.text();
      console.error('MP error:', mpResp.status, err);
      return res.status(502).json({ error: 'Erro MP: ' + mpResp.status });
    }

    const mpData    = await mpResp.json();
    const txData    = (mpData.point_of_interaction && mpData.point_of_interaction.transaction_data) || {};
    const qrBase64  = (txData.qr_code_base64 || '').replace(/[\r\n\t]/g, '');
    const ticketUrl = txData.ticket_url || '';
    const paymentId = String(mpData.id || '');

    console.log('PIX criado, payment_id:', paymentId, '| QR:', !!qrBase64, '| ticket_url:', !!ticketUrl);

    await inviteRef.update({
      'payment.mpPaymentId': paymentId,
      updatedAt: new Date().toISOString(),
    });

    return res.json({
      paymentId,
      pixQrCodeImg: qrBase64 ? 'data:image/png;base64,' + qrBase64 : '',
      checkoutUrl:  ticketUrl,
    });

  } catch (err) {
    console.error('Erro ao criar cobranca:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Webhook Mercado Pago ─────────────────────────────────────────────────────
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const body   = req.body;
    const type   = body.type   || '';
    const action = body.action || '';

    if (type !== 'payment' && action !== 'payment.updated') {
      return res.status(200).json({ received: true });
    }

    const paymentId = String((body.data && body.data.id) || '');
    if (!paymentId) return res.status(400).json({ error: 'id ausente' });

    const mpResp = await fetch(MP_API + '/v1/payments/' + paymentId, {
      headers: { 'Authorization': 'Bearer ' + MP_TOKEN },
    });
    if (!mpResp.ok) return res.status(200).json({ received: true });

    const payment = await mpResp.json();
    console.log('Webhook MP:', paymentId, '| status:', payment.status);

    if (payment.status !== 'approved') {
      return res.status(200).json({ received: true, paid: false });
    }

    const inviteCode = (payment.metadata && payment.metadata.invite_code) || '';
    let inviteRef = null;

    if (inviteCode) {
      inviteRef = db.collection('invites').doc(inviteCode);
    } else {
      const snap = await db.collection('invites')
        .where('payment.mpPaymentId', '==', paymentId).limit(1).get();
      if (!snap.empty) inviteRef = snap.docs[0].ref;
    }

    if (!inviteRef) {
      console.warn('Convite nao encontrado para payment_id:', paymentId);
      return res.status(200).json({ received: true });
    }

    await inviteRef.update({ paid: true, updatedAt: new Date().toISOString() });
    console.log('Convite liberado! payment_id:', paymentId);
    return res.status(200).json({ received: true, paid: true });

  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Convitta webhook rodando na porta ' + PORT));
