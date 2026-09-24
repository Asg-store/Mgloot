/* ════════════════════════════════════════════════════════════════
   MgLoot — Service Worker des notifications push (FCM)
   Version 5 — DIAGNOSTIC : affiche le type dans le titre de la notif
   Ce fichier DOIT être à la racine du site (même niveau que index.html),
   accessible à l'adresse : https://mgloot.com/firebase-messaging-sw.js
   C'est lui qui affiche la notification dans la barre du téléphone
   QUAND L'APP EST FERMÉE ou en arrière-plan (comme WhatsApp / Telegram / TikTok).
   ════════════════════════════════════════════════════════════════ */

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBj9sHzNDjH3aPLK4LC42s2mqwsDgbd38g",
  authDomain: "mglooti.firebaseapp.com",
  projectId: "mglooti",
  storageBucket: "mglooti.firebasestorage.app",
  messagingSenderId: "156127950943",
  appId: "1:156127950943:web:5007e3f0756a0b3b7b03ea"
});

var messaging = firebase.messaging();

// ── Notification reçue alors que l'app est FERMÉE / en arrière-plan ──
// Le serveur (send-push) envoie un message "data" → on construit la notif ici.
messaging.onBackgroundMessage(function(payload){
  // On accepte les deux formats : message "data" (envoyé par send-push) ET "notification"
  var data = (payload && payload.data) || {};
  var n    = (payload && payload.notification) || {};
  var _type = data.type || data.link || '';
  // 🔎 DIAGNOSTIC TEMPORAIRE : affiche le type reçu dans le titre pour vérifier la transmission
  var title = (data.title || n.title || '📢 MgLoot') + ' [type='+(_type||'VIDE')+']';
  var body  = data.body  || n.body  || 'Vous avez une nouvelle notification';
  var image = data.image || n.image || undefined;

  // Tag UNIQUE → les notifications s'empilent au lieu de s'écraser entre elles
  // (sauf si le serveur impose volontairement un tag pour remplacer la précédente)
  var tag = data.tag || ('asg-' + Date.now());

  var options = {
    body: body,
    icon: data.icon || '/notif-logo.png',
    badge: '/notif-badge.png',
    image: image,
    vibrate: [200, 100, 200, 100, 200],   // vibration plus franche
    tag: tag,
    renotify: true,
    requireInteraction: true,             // la notif reste affichée tant qu'on ne la touche pas
    silent: false,
    timestamp: Date.now(),
    actions: [
      { action: 'open', title: '👀 Ouvrir' },
      { action: 'close', title: '✖ Fermer' }
    ],
    data: {
      url: data.url || n.click_action || '/',
      type: data.type || data.link || '',   // 🎯 conserve le type → clic ouvre la bonne section
      icon: data.icon || ''
    }
  };
  return self.registration.showNotification(title, options);
});

// ── Au clic sur la notification : ouvrir / réactiver l'app ──
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  if (event.action === 'close') return;   // bouton « Fermer » → on ne fait rien
  var d = event.notification.data || {};
  var type = d.type || d.link || '';
  var target = d.url && d.url.indexOf('open=') >= 0 ? d.url : ('/?open=' + encodeURIComponent(type || ''));
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) {
          // 📨 App déjà ouverte : on lui envoie directement le type (plus fiable que navigate)
          try { c.postMessage({ __lootrOpen: type || '' }); } catch(e) {}
          try { c.navigate(target); } catch(e) {}
          return c.focus();
        }
      }
      // App fermée : on l'ouvre avec le paramètre dans l'URL
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

// Activation immédiate du nouveau SW (pas besoin de fermer tous les onglets)
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
// 🔄 Le client peut demander l'activation immédiate d'une nouvelle version
self.addEventListener('message', function(e){
  if(e && e.data && e.data.__skipWaiting){ self.skipWaiting(); }
});
