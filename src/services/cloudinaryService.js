const cloudinary = require('cloudinary').v2;

// =====================================================
// CONFIGURACIÓN
// =====================================================

// Usar las credenciales del .env
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Prefijo de carpeta para separar este proyecto de otros
const PROJECT_FOLDER = 'neurochat';

// =====================================================
// SUBIR IMAGEN DESDE BUFFER (multer memoryStorage)
// =====================================================
/**
 * Sube una imagen desde un buffer (multer memory storage).
 * @param {Buffer} buffer - El buffer de la imagen
 * @param {string} subfolder - Subcarpeta (e.g., 'products', 'vouchers')
 * @param {object} options - Opciones adicionales de Cloudinary
 * @returns {Promise<{url: string, publicId: string, width: number, height: number}>}
 */
async function uploadFromBuffer(buffer, subfolder = 'general', options = {}) {
    return new Promise((resolve, reject) => {
        const uploadOptions = {
            folder: `${PROJECT_FOLDER}/${subfolder}`,
            resource_type: 'image',
            transformation: [
                { quality: 'auto', fetch_format: 'auto' } // Auto-optimization
            ],
            ...options,
        };

        const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
            if (error) {
                console.error('❌ Cloudinary upload error:', error.message);
                reject(error);
            } else {
                resolve({
                    url: result.secure_url,
                    publicId: result.public_id,
                    width: result.width,
                    height: result.height,
                    format: result.format,
                    bytes: result.bytes,
                });
            }
        });

        stream.end(buffer);
    });
}

// =====================================================
// SUBIR IMAGEN DESDE BASE64 (para vouchers de WhatsApp)
// =====================================================
/**
 * Sube una imagen desde un string base64 (data URL o base64 puro).
 * @param {string} base64Data - La imagen en base64 (puede ser data URL o base64 puro)
 * @param {string} subfolder - Subcarpeta (e.g., 'vouchers')
 * @param {object} options - Opciones adicionales
 * @returns {Promise<{url: string, publicId: string}>}
 */
async function uploadFromBase64(base64Data, subfolder = 'general', options = {}) {
    try {
        // Ensure it's a proper data URL
        const dataUrl = base64Data.startsWith('data:')
            ? base64Data
            : `data:image/jpeg;base64,${base64Data}`;

        const result = await cloudinary.uploader.upload(dataUrl, {
            folder: `${PROJECT_FOLDER}/${subfolder}`,
            resource_type: 'image',
            ...options,
        });

        return {
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            bytes: result.bytes,
        };
    } catch (error) {
        console.error('❌ Cloudinary base64 upload error:', error.message);
        throw error;
    }
}

// =====================================================
// ELIMINAR IMAGEN
// =====================================================
/**
 * Elimina una imagen de Cloudinary por su public_id.
 * @param {string} publicId - El public_id de la imagen
 */
async function deleteImage(publicId) {
    try {
        const result = await cloudinary.uploader.destroy(publicId);
        return { success: result.result === 'ok' };
    } catch (error) {
        console.error('❌ Cloudinary delete error:', error.message);
        return { success: false, error: error.message };
    }
}

// =====================================================
// EXPORTS
// =====================================================
module.exports = {
    uploadFromBuffer,
    uploadFromBase64,
    deleteImage,
    cloudinary, // Export raw instance for advanced use
};
