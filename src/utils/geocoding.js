const axios = require('axios');

/**
 * Reverse geocoding using OpenStreetMap Nominatim (Free, no key required for low volume)
 * or Google Maps if a key is provided.
 */
async function reverseGeocode(lat, lng, googleMapsApiKey = null) {
    try {
        if (googleMapsApiKey) {
            const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${googleMapsApiKey}`;
            const res = await axios.get(url);
            if (res.data.status === 'OK' && res.data.results.length > 0) {
                const result = res.data.results[0];
                const address = result.formatted_address;
                
                // Extract city from address components
                let city = '';
                for (const component of result.address_components) {
                    if (component.types.includes('locality')) {
                        city = component.long_name;
                        break;
                    }
                }
                
                return { city, address };
            }
        }

        // Fallback to OpenStreetMap (Respect terms of use: include user-agent)
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
        const res = await axios.get(url, {
            headers: { 'User-Agent': 'NeuroChat-B2B-Agent/1.0' }
        });

        if (res.data) {
            const city = res.data.address.city || res.data.address.town || res.data.address.village || res.data.address.suburb || '';
            const address = res.data.display_name || '';
            return { city, address };
        }

        return { city: null, address: null };
    } catch (error) {
        console.error('[Geocoding] Reverse geocode error:', error.message);
        return { city: null, address: null };
    }
}

module.exports = { reverseGeocode };
