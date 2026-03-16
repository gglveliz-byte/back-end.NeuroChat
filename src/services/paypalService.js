const axios = require('axios');

const PAYPAL_API = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || process.env.PAYPAL_CLIENT_SECRET;

let accessToken = null;
let tokenExpiry = null;

/**
 * Obtener token de acceso de PayPal
 */
async function getAccessToken() {
  // Si tenemos un token válido, lo reutilizamos
  if (accessToken && tokenExpiry && new Date() < tokenExpiry) {
    return accessToken;
  }

  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new Error('PayPal no está configurado. Falta PAYPAL_CLIENT_ID o PAYPAL_SECRET');
  }

  try {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');

    const response = await axios.post(
      `${PAYPAL_API}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    accessToken = response.data.access_token;
    // Token expira en el tiempo dado menos un margen de 5 minutos
    tokenExpiry = new Date(Date.now() + (response.data.expires_in - 300) * 1000);

    return accessToken;
  } catch (error) {
    console.error('Error obteniendo token de PayPal:', error.response?.data || error.message);
    throw new Error('Error de autenticación con PayPal');
  }
}

/**
 * Crear una orden de pago
 * @param {Object} params - Parámetros de la orden
 * @param {number} params.amount - Monto a cobrar
 * @param {string} params.currency - Moneda (default: USD)
 * @param {string} params.description - Descripción del pago
 * @param {string} params.returnUrl - URL de retorno exitoso
 * @param {string} params.cancelUrl - URL de cancelación
 * @param {Object} params.metadata - Datos adicionales (client_service_id, etc.)
 */
async function createOrder({ amount, currency = 'USD', description, returnUrl, cancelUrl, metadata = {} }) {
  const token = await getAccessToken();

  const orderData = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: currency,
          value: parseFloat(amount).toFixed(2),
        },
        description: description,
        custom_id: JSON.stringify(metadata), // Para identificar el pago al capturar
      },
    ],
    application_context: {
      brand_name: 'ChatBot SaaS',
      landing_page: 'LOGIN',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  };

  try {
    const response = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders`,
      orderData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const order = response.data;

    // Buscar el link de aprobación
    const approvalLink = order.links.find(link => link.rel === 'approve');

    return {
      orderId: order.id,
      status: order.status,
      approvalUrl: approvalLink?.href,
    };
  } catch (error) {
    console.error('Error creando orden PayPal:', error.response?.data || error.message);
    throw new Error('Error al crear la orden de pago');
  }
}

/**
 * Capturar una orden aprobada
 * @param {string} orderId - ID de la orden de PayPal
 */
async function captureOrder(orderId) {
  const token = await getAccessToken();

  try {
    const response = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const capture = response.data;

    // Obtener detalles del pago
    const captureDetails = capture.purchase_units[0].payments.captures[0];
    const metadata = JSON.parse(capture.purchase_units[0].custom_id || '{}');

    return {
      success: true,
      orderId: capture.id,
      status: capture.status,
      transactionId: captureDetails.id,
      amount: parseFloat(captureDetails.amount.value),
      currency: captureDetails.amount.currency_code,
      metadata,
      payerEmail: capture.payer?.email_address,
      payerName: capture.payer?.name?.given_name,
    };
  } catch (error) {
    console.error('Error capturando orden PayPal:', error.response?.data || error.message);

    // Verificar si el error es porque la orden ya fue capturada
    if (error.response?.data?.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED') {
      return {
        success: false,
        error: 'Esta orden ya fue procesada',
        alreadyCaptured: true,
      };
    }

    throw new Error('Error al procesar el pago');
  }
}

/**
 * Obtener detalles de una orden
 * @param {string} orderId - ID de la orden
 */
async function getOrderDetails(orderId) {
  const token = await getAccessToken();

  try {
    const response = await axios.get(
      `${PAYPAL_API}/v2/checkout/orders/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error('Error obteniendo detalles de orden:', error.response?.data || error.message);
    throw new Error('Error al obtener detalles de la orden');
  }
}

/**
 * Verificar si PayPal está configurado
 */
function isConfigured() {
  return !!(PAYPAL_CLIENT_ID && PAYPAL_SECRET);
}

/**
 * Verificar conexión con PayPal
 */
async function checkConnection() {
  if (!isConfigured()) {
    return { success: false, error: 'PayPal no está configurado' };
  }

  try {
    await getAccessToken();
    return { success: true, mode: process.env.PAYPAL_MODE || 'sandbox' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  createOrder,
  captureOrder,
  getOrderDetails,
  isConfigured,
  checkConnection,
};
