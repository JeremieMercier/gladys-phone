# Gladys Phone

Cette intégration reçoit les positions GPS envoyées **en direct** par
l'application mobile Gladys Phone — y
compris quand l'application est fermée — et les transmet à la localisation
utilisateur de Gladys. Vos scènes de présence (arrivée / départ de la maison)
se déclenchent ainsi en temps réel, sans attendre la prochaine ouverture de
l'application.

Elle fait aussi apparaître chaque téléphone comme un **appareil Gladys** avec
ses capteurs — batterie (%) et état de charge — utilisables dans vos scènes
(« batterie du téléphone sous 20 % → notification ») et historisés comme
n'importe quel capteur.

## Comment ça marche

1. Sur le téléphone, Gladys Phone enregistre la position via un service natif
   qui survit à la fermeture de l'application et au redémarrage du téléphone.
2. À intervalle régulier (configurable dans l'application), ce service envoie
   la dernière position au **récepteur** installé par cette intégration.
3. Le récepteur transmet la position à votre Gladys via son API officielle
   (`/api/v1/user/…/location`) : c'est la même mécanique que l'application
   officielle Gladys, vos scènes et l'historique de localisation fonctionnent
   à l'identique.

Chaque téléphone s'authentifie avec **sa propre clé d'API Gladys** (créée
automatiquement par l'application Gladys Phone à la connexion). Le récepteur
ne stocke aucun secret : une clé invalide est simplement rejetée par Gladys.

## Installation

1. Installez l'intégration depuis le catalogue Gladys.
2. Dans l'écran de configuration, notez l'adresse du récepteur affichée dans
   le bloc « Mise en route » (`http://<votre-gladys>:<port>`). Le port est
   choisi par Gladys à l'installation.
3. Rendez cette adresse joignable par votre téléphone **hors de chez vous** :
   - **Reverse proxy** (recommandé si vous en avez déjà un — Nginx Proxy
     Manager, Traefik, Caddy…) : créez une entrée HTTPS, par exemple
     `https://tracks.mondomaine.fr`, qui pointe vers l'adresse du récepteur.
   - **VPN** (WireGuard, Tailscale…) : si votre téléphone est connecté en
     permanence au VPN, l'adresse locale suffit.
4. Dans l'application Gladys Phone, renseignez cette URL publique dans les
   réglages du partage de position.
5. Cliquez sur « Tester le récepteur » dans l'écran de configuration pour
   vérifier que tout est en place.

## Configuration

| Réglage              | Description                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL locale de Gladys | Adresse à laquelle le récepteur joint votre instance Gladys. Laissez vide : elle est détectée automatiquement. Ne la renseignez que si le test signale que Gladys est injoignable (ex. `http://192.168.1.10`). |

## Dépannage

- **« Le conteneur récepteur ne répond pas »** : consultez les logs de
  l'intégration dans l'écran de supervision.
- **« Gladys est injoignable »** : renseignez l'URL locale de votre instance
  dans la configuration (celle que vous utilisez dans votre navigateur sur
  votre réseau local).
- **Les positions n'arrivent pas depuis l'extérieur** : vérifiez que l'URL
  publique (reverse proxy ou VPN) atteint bien le port du récepteur — un
  `curl https://votre-url/health` doit répondre `{"status":"ok"}`.
- **Après une réinstallation de l'intégration**, Gladys peut attribuer un
  nouveau port au récepteur : mettez à jour votre entrée de reverse proxy.

## Exposition sur Internet (bonnes pratiques)

- Exposez toujours le récepteur en **HTTPS** (le reverse proxy s'en charge) :
  la clé d'API Gladys transite dans chaque requête.
- Le plan de contrôle interne du récepteur écoute sur un port séparé jamais
  publié : il reste inatteignable depuis l'extérieur, votre reverse proxy n'a
  accès qu'aux routes `/health`, `/users/…` et `/devices/…`.
- Activez si possible une **limitation de débit** sur votre reverse proxy
  pour l'hôte du récepteur : les requêtes non authentifiées sont rejetées,
  mais un plafond évite qu'un flux abusif ne sollicite votre Gladys.

## Capteurs du téléphone

1. Activez la remontée des capteurs dans les réglages de l'application
   Gladys Phone (elle est active par défaut dès qu'un récepteur est
   configuré).
2. Ouvrez l'écran de cette intégration dans Gladys : le téléphone apparaît
   dans la **découverte** avec son nom. Ajoutez-le.
3. Les états (batterie, en charge) arrivent ensuite automatiquement, avec
   leur horodatage d'origine.

Bon à savoir :

- Les capteurs sont relevés quand l'application tourne (ouverture, retours en
  avant-plan). Contrairement à la position, il n'y a pas de remontée
  « application fermée depuis plusieurs jours » : la batterie évolue
  lentement, les relevés en attente partent à la prochaine ouverture.
- Les états transitent par une mémoire tampon du récepteur : un redémarrage
  du conteneur peut perdre au pire quelques secondes de relevés — sans effet
  sur l'historique de position.
- Toute clé d'API Gladys valide du foyer peut pousser des états : le modèle
  de confiance est celui de la maison, comme pour les positions.

## Formats acceptés

Le récepteur accepte des requêtes `POST /users/<selector>/positions` avec un
en-tête `Authorization: Bearer <clé d'API Gladys>` et un corps :

```json
{ "points": [{ "latitude": 45.5, "longitude": -73.5, "accuracy": 8.2 }] }
```

C'est le format émis nativement par le plugin de géolocalisation de
Gladys Phone ; d'autres applications peuvent donc aussi l'utiliser.

Pour les capteurs : `POST /devices/<identifiant>/states`, même en-tête
`Authorization: Bearer <clé d'API Gladys>`, et un corps :

```json
{
  "device": { "name": "iPhone de Jérémie", "model": "iPhone15,2", "platform": "ios" },
  "states": [{ "sensor": "battery-level", "value": 87, "recorded_at": "2026-08-15T10:00:00Z" }]
}
```

Capteurs reconnus : `battery-level` (0–100) et `battery-charging` (0/1). Les
capteurs inconnus sont acceptés puis ignorés — une application plus récente
que le récepteur ne perd jamais son lot.
