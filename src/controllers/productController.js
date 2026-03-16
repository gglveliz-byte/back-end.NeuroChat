const { query } = require('../config/database');
const { uploadFromBuffer, deleteImage } = require('../services/cloudinaryService');

// =====================================================
// Listar Productos (por cliente)
// =====================================================
const getProducts = async (req, res) => {
    try {
        const clientId = req.user.id; // From auth middleware
        const { search, category, limit = 50, offset = 0 } = req.query;

        let sql = 'SELECT * FROM products WHERE client_id = $1';
        let params = [clientId];
        let paramCount = 1;

        if (search) {
            paramCount++;
            sql += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
            params.push(`%${search}%`);
        }

        if (category) {
            paramCount++;
            sql += ` AND category = $${paramCount}`;
            params.push(category);
        }

        sql += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        params.push(limit, offset);

        const result = await query(sql, params);

        // Contar total para paginación
        const countSql = 'SELECT COUNT(*) FROM products WHERE client_id = $1';
        const countResult = await query(countSql, [clientId]);

        const products = result.rows.map(p => ({
            ...p,
            media_urls: typeof p.media_urls === 'string' ? JSON.parse(p.media_urls) : (p.media_urls || [])
        }));

        res.json({
            success: true,
            data: products,
            pagination: {
                total: parseInt(countResult.rows[0].count),
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
        });

    } catch (error) {
        console.error('Error obteniendo productos:', error);
        res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
};

// =====================================================
// Crear Producto
// =====================================================
const createProduct = async (req, res) => {
    try {
        const clientId = req.user.id;
        const { name, description, price, currency = 'USD', category, stock } = req.body;

        if (!name || !price) {
            return res.status(400).json({ success: false, error: 'Nombre y precio son obligatorios' });
        }

        const parsedPrice = parseFloat(String(price).replace(',', '.'));
        if (isNaN(parsedPrice) || parsedPrice < 0) {
            return res.status(400).json({ success: false, error: 'El precio debe ser un número válido' });
        }

        const parsedStock = parseInt(stock) || 0;

        // Manejo de imagen (Cloudinary)
        let mediaUrls = [];
        if (req.file) {
            if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
                console.error('❌ Cloudinary env vars missing:', {
                    cloud_name: !!process.env.CLOUDINARY_CLOUD_NAME,
                    api_key: !!process.env.CLOUDINARY_API_KEY,
                    api_secret: !!process.env.CLOUDINARY_API_SECRET
                });
                return res.status(500).json({ success: false, error: 'Cloudinary no está configurado. Verifica las variables de entorno.' });
            }
            try {
                const uploaded = await uploadFromBuffer(req.file.buffer, 'products');
                mediaUrls.push(uploaded.url);
            } catch (uploadErr) {
                console.error('❌ Error subiendo imagen a Cloudinary:', uploadErr.message, uploadErr.http_code);
                return res.status(400).json({ success: false, error: `Error al subir imagen: ${uploadErr.message || 'Verifica formato y tamaño'}` });
            }
        }

        const sql = `
      INSERT INTO products (client_id, name, description, price, currency, category, stock, media_urls, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
      RETURNING *
    `;

        const params = [
            clientId,
            name.trim(),
            (description || '').trim(),
            parsedPrice,
            currency,
            category || 'General',
            parsedStock,
            JSON.stringify(mediaUrls)
        ];

        const result = await query(sql, params);

        res.status(201).json({
            success: true,
            message: 'Producto creado exitosamente',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('Error creando producto:', error);
        res.status(500).json({ success: false, error: `Error al crear producto: ${error.message}` });
    }
};

// =====================================================
// Actualizar Producto
// =====================================================
const updateProduct = async (req, res) => {
    try {
        const clientId = req.user.id;
        const { id } = req.params;
        const { name, description, price, currency, category, stock, status } = req.body;

        // Verificar propiedad
        const checkOwner = await query('SELECT * FROM products WHERE id = $1 AND client_id = $2', [id, clientId]);
        if (checkOwner.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Producto no encontrado' });
        }

        const parsedPrice = price ? parseFloat(String(price).replace(',', '.')) : null;
        if (price && (isNaN(parsedPrice) || parsedPrice < 0)) {
            return res.status(400).json({ success: false, error: 'El precio debe ser un número válido' });
        }

        let mediaUrls = checkOwner.rows[0].media_urls || [];
        if (req.file) {
            try {
                // Delete old image from Cloudinary if it's a Cloudinary URL
                if (mediaUrls.length > 0 && mediaUrls[0].includes('cloudinary')) {
                    const oldPublicId = mediaUrls[0].split('/upload/')[1]?.replace(/\.\w+$/, '').replace(/^v\d+\//, '');
                    if (oldPublicId) await deleteImage(oldPublicId).catch(() => { });
                }
                const uploaded = await uploadFromBuffer(req.file.buffer, 'products');
                mediaUrls = [uploaded.url];
            } catch (uploadErr) {
                console.error('❌ Error subiendo imagen a Cloudinary:', uploadErr.message);
                return res.status(400).json({ success: false, error: `Error al subir imagen: ${uploadErr.message || 'Verifica formato y tamaño'}` });
            }
        }

        const sql = `
      UPDATE products
      SET name = COALESCE($1, name),
          description = COALESCE($2, description),
          price = COALESCE($3, price),
          currency = COALESCE($4, currency),
          category = COALESCE($5, category),
          stock = COALESCE($6, stock),
          is_active = COALESCE($7, is_active),
          media_urls = COALESCE($8, media_urls),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $9 AND client_id = $10
      RETURNING *
    `;

        const parsedStock = stock !== undefined && stock !== '' ? parseInt(stock) : null;

        const params = [
            name || null, description || null, parsedPrice, currency || null, category || null,
            isNaN(parsedStock) ? null : parsedStock, status === 'inactive' ? false : true, JSON.stringify(mediaUrls),
            id, clientId
        ];

        const result = await query(sql, params);

        res.json({
            success: true,
            message: 'Producto actualizado',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('Error actualizando producto:', error);
        res.status(500).json({ success: false, error: `Error al actualizar producto: ${error.message}` });
    }
};

// =====================================================
// Eliminar Producto (Logical Delete o Físico)
// =====================================================
const deleteProduct = async (req, res) => {
    try {
        const clientId = req.user.id;
        const { id } = req.params;

        const result = await query(
            'DELETE FROM products WHERE id = $1 AND client_id = $2 RETURNING id',
            [id, clientId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Producto no encontrado' });
        }

        res.json({ success: true, message: 'Producto eliminado' });

    } catch (error) {
        console.error('Error eliminando producto:', error);
        res.status(500).json({ success: false, error: 'Error al eliminar producto' });
    }
};

module.exports = {
    getProducts,
    createProduct,
    updateProduct,
    deleteProduct
};
