/**
 * NeuroChat Voice AI — VoxEngine Scenario
 *
 * INSTRUCCIONES DE USO:
 * 1. Ve a Voximplant Dashboard → Applications → neurochat → Scenarios
 * 2. Crea un nuevo Scenario llamado "voice_ai"
 * 3. Pega el contenido de este archivo
 * 4. En "Rules", crea una regla que apunte a este scenario
 * 5. En customData de la regla, pon:
 *    {"backendUrl":"https://tu-backend.com","webhookSecret":"neurochat-secret"}
 *
 * FLUJO:
 *  Llamada entra → llama /call-start → reproduce bienvenida
 *  → graba usuario → llama /process-audio → reproduce respuesta IA
 *  → repite hasta timeout (10 min) o despedida
 *  → /call-end registra métricas
 */

// ─────────────────────────────────────────────
// Variables globales de la sesión
// ─────────────────────────────────────────────
var BACKEND_URL = '__BACKEND_URL__'; // Reemplazado automáticamente al subir
var WEBHOOK_SECRET = 'neurochat-secret';
var call;
var callId;
var isProcessing = false;
var exchangeCount = 0;
var timeoutHandle;
var isEnding = false;

// ─────────────────────────────────────────────
// Inicio de la llamada
// ─────────────────────────────────────────────
VoxEngine.addEventListener(AppEvents.CallAlerting, function(e) {
  call = e.call;
  callId = VoxEngine.callId();

  // Leer configuración desde customData de la regla
  try {
    var customData = JSON.parse(VoxEngine.customData() || '{}');
    if (customData.backendUrl) BACKEND_URL = customData.backendUrl;
    if (customData.webhookSecret) WEBHOOK_SECRET = customData.webhookSecret;
  } catch (ex) {
    Logger.write('[NeuroChat] Error parseando customData: ' + ex.message);
  }

  call.answer();
  Logger.write('[NeuroChat] Llamada respondida. CallId: ' + callId);

  // Timeout máximo: el backend determina cuánto es (default 10 min)
  // Iniciamos con 11 min como seguro y dejamos que el backend maneje el timeout real
  timeoutHandle = setTimeout(function() {
    if (!isEnding) {
      Logger.write('[NeuroChat] Timeout máximo alcanzado');
      handleTimeout();
    }
  }, 660000); // 11 minutos

  // Notificar al backend e iniciar la llamada
  httpPost('/api/v1/voice/call-start', {
    callId: callId,
    callerPhone: call.callerID() || 'unknown',
    calledPhone: call.number() || 'unknown',
  }, function(data) {
    if (data.blocked) {
      Logger.write('[NeuroChat] Llamada bloqueada: ' + data.message);
      callSay(data.message || 'Lo sentimos, no podemos atenderte en este momento.', function() {
        endCall('blocked');
      });
      return;
    }

    Logger.write('[NeuroChat] Llamada iniciada. Reproduciendo bienvenida...');

    if (data.welcomeAudioUrl) {
      playAudio(data.welcomeAudioUrl, function() {
        startListening();
      });
    } else {
      callSay(data.welcomeText || 'Hola, ¿en qué puedo ayudarte?', function() {
        startListening();
      });
    }

  }, function(err) {
    Logger.write('[NeuroChat] Error en call-start: ' + JSON.stringify(err));
    callSay('Lo sentimos, hay un problema técnico. Por favor intente más tarde.', function() {
      endCall('error');
    });
  });

  // Manejar cuelgue del usuario
  call.addEventListener(CallEvents.Disconnected, function(ev) {
    Logger.write('[NeuroChat] Usuario colgó. Duración: ' + (ev.duration || 0) + 's');
    isEnding = true;
    clearTimeout(timeoutHandle);
    httpPost('/api/v1/voice/call-end', {
      callId: callId,
      duration: ev.duration || 0,
      reason: 'user_hangup',
    }, function() {
      VoxEngine.terminate();
    }, function() {
      VoxEngine.terminate();
    });
  });
});

// ─────────────────────────────────────────────
// Grabar audio del usuario (con detección de silencio)
// ─────────────────────────────────────────────
function startListening() {
  if (isProcessing || isEnding) return;

  Logger.write('[NeuroChat] Escuchando usuario (intercambio #' + (exchangeCount + 1) + ')');

  // Reproducir tono corto para indicar que escucha (opcional)
  // call.playTone(440, 100, 1000); // 440Hz, 100ms duración

  // Iniciar grabación con detección de silencio
  call.record({
    maxLength: 30,        // máximo 30 segundos de grabación
    onSilence: true,      // detener cuando hay silencio
    silenceTimeout: 1500, // 1.5 segundos de silencio = fin del habla
    compressed: true,     // formato comprimido (MP3)
  });

  // Manejar fin de grabación
  call.addEventListener(CallEvents.RecordStopped, function handler(ev) {
    call.removeEventListener(CallEvents.RecordStopped, handler);

    if (isEnding) return;

    if (!ev.url) {
      Logger.write('[NeuroChat] Grabación vacía, volviendo a escuchar');
      startListening();
      return;
    }

    Logger.write('[NeuroChat] Audio grabado: ' + ev.url);
    isProcessing = true;
    processUserAudio(ev.url);
  });
}

// ─────────────────────────────────────────────
// Enviar audio al backend y reproducir respuesta
// ─────────────────────────────────────────────
function processUserAudio(audioUrl) {
  exchangeCount++;

  httpPost('/api/v1/voice/process-audio', {
    callId: callId,
    audioUrl: audioUrl,
    exchangeCount: exchangeCount,
  }, function(data) {
    isProcessing = false;

    if (isEnding) return;

    Logger.write('[NeuroChat] Respuesta backend: acción=' + data.action);

    if (data.action === 'respond') {
      if (data.audioUrl) {
        playAudio(data.audioUrl, function() {
          startListening();
        });
      } else if (data.text) {
        callSay(data.text, function() {
          startListening();
        });
      } else {
        startListening();
      }

    } else if (data.action === 'transfer') {
      Logger.write('[NeuroChat] Transfiriendo a: ' + data.transferPhone);
      if (data.audioUrl) {
        playAudio(data.audioUrl, function() {
          doTransfer(data.transferPhone, data.backupPhone);
        });
      } else {
        callSay(data.message || 'Te conectaré con un asesor.', function() {
          doTransfer(data.transferPhone, data.backupPhone);
        });
      }

    } else if (data.action === 'hangup') {
      if (data.audioUrl) {
        playAudio(data.audioUrl, function() {
          endCall('goodbye');
        });
      } else {
        callSay(data.message || '¡Hasta luego! Que tengas un excelente día.', function() {
          endCall('goodbye');
        });
      }

    } else if (data.action === 'retry') {
      if (data.audioUrl) {
        playAudio(data.audioUrl, function() {
          startListening();
        });
      } else {
        callSay(data.message || '¿Podrías repetirlo?', function() {
          startListening();
        });
      }

    } else {
      startListening();
    }

  }, function(err) {
    isProcessing = false;
    Logger.write('[NeuroChat] Error en process-audio: ' + JSON.stringify(err));
    if (!isEnding) {
      callSay('Disculpa, tuve un problema técnico. ¿Puedes repetir tu consulta?', function() {
        startListening();
      });
    }
  });
}

// ─────────────────────────────────────────────
// Timeout: tiempo máximo de llamada
// ─────────────────────────────────────────────
function handleTimeout() {
  isEnding = true;
  httpPost('/api/v1/voice/timeout-transfer', {
    callId: callId,
  }, function(data) {
    callSay(data.message || 'El tiempo máximo de atención ha llegado. Te conectaré con un asesor.', function() {
      if (data.transferPhone) {
        doTransfer(data.transferPhone, data.backupPhone);
      } else {
        endCall('timeout');
      }
    });
  }, function() {
    callSay('El tiempo máximo de atención ha llegado. Hasta luego.', function() {
      endCall('timeout');
    });
  });
}

// ─────────────────────────────────────────────
// Transferencia a humano
// ─────────────────────────────────────────────
function doTransfer(primaryPhone, backupPhone) {
  if (!primaryPhone) {
    Logger.write('[NeuroChat] Sin número de transferencia configurado');
    callSay('Lo sentimos, no hay asesores disponibles. Te escribiremos pronto.', function() {
      endCall('transfer_failed');
    });
    return;
  }

  Logger.write('[NeuroChat] Iniciando transferencia a: ' + primaryPhone);

  var transferCall = VoxEngine.callPSTN(primaryPhone, call.number());

  transferCall.addEventListener(CallEvents.Connected, function() {
    Logger.write('[NeuroChat] Agente conectado, bridgeando llamadas');
    VoxEngine.easyProcess(call, transferCall, function() {
      httpPost('/api/v1/voice/call-end', {
        callId: callId,
        duration: 0,
        reason: 'transferred',
      }, function() {}, function() {});
      VoxEngine.terminate();
    });
  });

  transferCall.addEventListener(CallEvents.Failed, function() {
    Logger.write('[NeuroChat] Agente no disponible, intentando respaldo: ' + backupPhone);

    if (backupPhone && backupPhone !== primaryPhone) {
      var backupCall = VoxEngine.callPSTN(backupPhone, call.number());

      backupCall.addEventListener(CallEvents.Connected, function() {
        VoxEngine.easyProcess(call, backupCall, function() {
          httpPost('/api/v1/voice/call-end', { callId: callId, duration: 0, reason: 'transferred' }, function() {}, function() {});
          VoxEngine.terminate();
        });
      });

      backupCall.addEventListener(CallEvents.Failed, function() {
        // Ambos números fallaron
        callSay('Lo sentimos, nuestros asesores están ocupados. Te enviaremos un mensaje de WhatsApp para coordinar.', function() {
          endCall('transfer_failed');
        });
      });
    } else {
      callSay('Lo sentimos, nuestros asesores están ocupados. Te enviaremos un mensaje de WhatsApp para coordinar.', function() {
        endCall('transfer_failed');
      });
    }
  });
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function playAudio(audioUrl, onFinished) {
  call.startPlayback(audioUrl);
  var handler = function() {
    call.removeEventListener(CallEvents.PlaybackFinished, handler);
    if (onFinished && !isEnding) onFinished();
  };
  call.addEventListener(CallEvents.PlaybackFinished, handler);
}

function callSay(text, onFinished) {
  call.say(text, Language.SPANISH_SPAIN, {
    voice: 'Lucia', // Voz en español de Voximplant (fallback si TTS nuestro no carga)
  });
  var handler = function() {
    call.removeEventListener(CallEvents.PlaybackFinished, handler);
    if (onFinished && !isEnding) onFinished();
  };
  call.addEventListener(CallEvents.PlaybackFinished, handler);
}

function endCall(reason) {
  isEnding = true;
  clearTimeout(timeoutHandle);
  Logger.write('[NeuroChat] Terminando llamada. Razón: ' + reason);
  httpPost('/api/v1/voice/call-end', {
    callId: callId,
    duration: 0,
    reason: reason,
  }, function() {
    call.hangup();
    VoxEngine.terminate();
  }, function() {
    call.hangup();
    VoxEngine.terminate();
  });
}

function httpPost(path, data, onSuccess, onError) {
  Net.httpRequest({
    url: BACKEND_URL + path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Voximplant-Secret': WEBHOOK_SECRET,
    },
    postData: JSON.stringify(data),
    success: function(response) {
      try {
        var parsed = JSON.parse(response.text);
        if (onSuccess) onSuccess(parsed);
      } catch (ex) {
        Logger.write('[NeuroChat] Error parseando respuesta: ' + ex.message);
        if (onError) onError('parse_error');
      }
    },
    error: function(e) {
      Logger.write('[NeuroChat] HTTP Error en ' + path + ': ' + JSON.stringify(e));
      if (onError) onError(e);
    },
  });
}
