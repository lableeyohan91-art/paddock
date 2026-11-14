# Paddock — appli de course pour Carrera Digital 132 (V1)

## Lancer l'appli sur le PC

1. Double-clique sur **`Lancer Paddock.bat`**. Le navigateur s'ouvre sur `http://localhost:8132`.
   - Laisse la fenêtre noire ouverte pendant que tu joues ; ferme-la pour arrêter.
   - Ouvre l'appli dans **Chrome ou Edge** : ce sont les seuls navigateurs qui gèrent le Bluetooth.
2. Allume le circuit avec l'AppConnect branché sur la Control Unit.
3. Dans l'appli, clique sur **Non connecté** en haut à droite, puis sur **Carrera AppConnect**, et choisis l'appareil dans la liste.
   - Le Bluetooth du PC doit être activé.
   - Ferme l'appli SmartRace sur ton téléphone : l'AppConnect n'accepte qu'une connexion à la fois.

Pas de circuit sous la main ? Choisis **Simulateur** : des voitures virtuelles tournent et réagissent à la météo comme les vraies.

## Ce que fait la V1

- **Sessions** : essais libres, qualification et course (au nombre de tours ou à la durée).
- **Départ** : feux de la Control Unit ou départ lancé.
- **Classement en direct** : tours, dernier tour, meilleur tour (violet = meilleur de la session, vert = record perso), écarts, arrêts aux stands, carburant.
- **Secteurs** : affichés automatiquement dès que des Check Lane envoient des temps intermédiaires.
- **Réglage vitesse / freinage** par voiture, de 0 à 15.
- **Météo** : soleil, nuages, bruine, pluie, orage.
  - La piste se mouille puis sèche progressivement, et ralentit réellement les voitures.
  - En mode dynamique, le temps change tout seul pendant la session, avec une prévision affichée.
- **Drapeau jaune** : ralentit toutes les voitures jusqu'au drapeau vert.
- **Annonces vocales** en français : meilleurs tours, météo, drapeaux, dernier tour, arrivée.
- **Statistiques** par circuit :
  - record, meilleur tour et régularité de chaque pilote, meilleur tour par voiture ;
  - courbe de progression, historique des sessions, filtre sec / mouillé.
- **Sauvegarde** : export / import dans Réglages.

## Le moteur de performance

Chaque voiture a une vitesse et un freinage de base. Les effets actifs (météo, drapeau jaune…) multiplient ces valeurs, et l'appli renvoie le résultat à la Control Unit dès qu'il change. La colonne **Vitesse** de l'écran de course montre la valeur appliquée (par ex. `11/15 ↓`) ; survole-la pour voir les effets en cours.

Les prochains effets se brancheront au même endroit : pneus tendre / medium / dur et usure, poids du carburant, dégâts…

## Points à vérifier sur ton circuit

Le protocole vient de la bibliothèque open source *carreralib*. Il n'a pas encore été testé sur ta Control Unit. Points à surveiller lors du premier essai :

- **Connexion** : l'AppConnect apparaît-il dans la liste Bluetooth ? La pastille passe-t-elle au vert ?
- **Passages** : les tours sont-ils comptés à chaque passage sur la ligne ?
- **Feux** : le bouton « Lancer les feux » déclenche-t-il la séquence de la Control Unit ?
  - Si l'appli reste bloquée sur les feux, utilise « Forcer le départ » et note ce qui s'est passé.
- **Vitesse** : mets la météo sur « Orage ». Les voitures doivent ralentir nettement, même manette à fond.
- **Stands** : un passage dans la voie des stands est-il détecté (badge STAND) ?

En cas de souci, l'onglet **Réglages → Diagnostic** affiche le journal et les compteurs.

## Structure du code

```
index.html, css/app.css      interface
js/cu/protocol.js            encodage/décodage du protocole Control Unit
js/cu/ble.js                 connexion Bluetooth AppConnect
js/cu/simulator.js           Control Unit simulée
js/cu/controlunit.js         boucle d'interrogation + file de commandes
js/race.js                   moteur de session (tours, classement, fin)
js/performance.js            moteur de performance (effets -> vitesse/freinage)
js/weather.js                météo et humidité de piste
js/db.js                     stockage local (IndexedDB)
js/views/*.js                écrans
tests/protocol.test.mjs      tests du protocole (node tests/protocol.test.mjs)
```

## Sur le téléphone Android (étape suivante)

L'appli est déjà prévue pour mobile (installable sur l'écran d'accueil, Bluetooth dans Chrome Android). Pour l'utiliser sur le téléphone, il faut la mettre en ligne en HTTPS, par exemple sur GitHub Pages, gratuit. On le fera ensemble.
