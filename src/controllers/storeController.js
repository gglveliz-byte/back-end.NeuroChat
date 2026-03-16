const { query } = require('../config/database');
const telegramService = require('../services/telegramService');

// =====================================================
// Obtener datos de la tienda pública por slug
// =====================================================
const getStoreBySlug = async (req, res) => {
    try {
        const { slug } = req.params;

        if (!slug) {
            return res.status(400).json({ success: false, error: 'Slug requerido' });
        }

        // 1. Obtener datos del negocio
        const businessResult = await query(`
      SELECT
        b.id, b.client_id, b.name, b.description, b.store_description, b.slug,
        b.logo_url, b.banner_url,
        b.phone, b.email, b.website, b.colors,
        b.address, b.country, b.industry
      FROM businesses b
      WHERE b.slug = $1
    `, [slug]);

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Tienda no encontrada' });
        }

        const business = businessResult.rows[0];

        // 2. Obtener productos activos del cliente asociado al negocio
        const productsResult = await query(`
      SELECT
        p.id, p.name, p.description, p.price, p.currency,
        p.category, p.stock, p.media_urls
      FROM products p
      WHERE p.client_id = $1 AND p.is_active = true
      ORDER BY p.category ASC, p.name ASC
    `, [business.client_id]);

        const products = productsResult.rows.map(p => ({
            ...p,
            media_urls: typeof p.media_urls === 'string' ? JSON.parse(p.media_urls) : (p.media_urls || [])
        }));

        // 3. Obtener servicios conectados del cliente
        const servicesResult = await query(`
      SELECT
        cs.id, cs.config, s.code
      FROM client_services cs
      JOIN services s ON cs.service_id = s.id
      WHERE cs.client_id = $1
        AND cs.status NOT IN ('inactive', 'cancelled')
    `, [business.client_id]);

        // Bot de Telegram (global) para deep links
        let telegramBotUsername = null;
        try {
            const botInfo = await telegramService.getGlobalBotInfo();
            if (botInfo && botInfo.username) telegramBotUsername = botInfo.username;
        } catch { /* sin telegram configurado */ }

        // Construir lista de canales de contacto
        const channels = [];
        for (const svc of servicesResult.rows) {
            const creds = svc.config?.platform_credentials || {};
            const code = svc.code;

            if (code === 'whatsapp' && creds.display_phone) {
                channels.push({
                    type: 'whatsapp',
                    label: 'WhatsApp',
                    phone: creds.display_phone
                });
            } else if (code === 'instagram' && creds.instagram_username) {
                channels.push({
                    type: 'instagram',
                    label: 'Instagram',
                    username: creds.instagram_username
                });
            } else if (code === 'messenger' && (creds.page_name || creds.page_id)) {
                channels.push({
                    type: 'messenger',
                    label: 'Messenger',
                    pageId: creds.page_id,
                    pageName: creds.page_name
                });
            } else if (code === 'telegram' && telegramBotUsername) {
                channels.push({
                    type: 'telegram',
                    label: 'Telegram',
                    botUsername: telegramBotUsername,
                    startParam: svc.id  // client_service_id para deep link
                });
            } else if (code === 'webchat') {
                channels.push({
                    type: 'webchat',
                    label: 'Chat en Vivo',
                    clientServiceId: svc.id
                });
            }
        }

        // 4. Organizar respuesta
        res.json({
            success: true,
            data: {
                business: {
                    name: business.name,
                    description: business.description,
                    store_description: business.store_description,
                    logo: business.logo_url,
                    banner: business.banner_url,
                    phone: business.phone,
                    email: business.email,
                    website: business.website,
                    colors: business.colors,
                    address: business.address,
                    slug: business.slug,
                    channels  // canales de contacto disponibles
                },
                products: products
            }
        });

    } catch (error) {
        console.error('Error obteniendo tienda:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor', details: error.message });
    }
};

module.exports = {
    getStoreBySlug
};
