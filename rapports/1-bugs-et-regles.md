# Rapport 1 — Bugs, règles manquantes et incohérences

**Essais du 15/11/2026, au simulateur (v1.32).** Aucune modification de l'appli n'a été faite pendant les essais.

## 🔴 Bugs à corriger

### 1. Deux appuis sur GO mettent la course en drapeau rouge
- **Ce qui se passe :** après le premier appui, le bouton GO reste affiché et actif un court instant. Un second appui, même 0,1 s plus tard, envoie à nouveau START à la Control Unit. Celle-ci coupe la piste. L'appli note « départ donné » puis « La Control Unit a arrêté la course (faux départ ?) : drapeau rouge ».
- **Reproduit 2 fois sur 2** au simulateur, avec un double appui sur le vrai bouton.
- **Même risque** avec le bouton « Nouvelle relance » et le bouton Drapeau rouge.
- **Correction proposée :** désactiver le bouton dès le premier appui, et ignorer `startSession()` si la séance est déjà en feux (`armed`) ou en course.

### 2. Vue pilote : deux pilotes qui appuient sur VSC presque en même temps annulent le VSC
- **Ce qui se passe :** la commande « VSC » de la vue pilote fonctionne comme un interrupteur. Si deux pilotes appuient à 150 ms d'écart, le premier lance le VSC, et le second **lance déjà le décompte de fin**. Le VSC ne dure alors que 4 s.
- La vue pilote ne voit l'état de la course qu'avec environ 1 s de retard, donc ça arrivera dès que deux pilotes réagissent au même accident.
- **Correction proposée :** que la vue pilote envoie une intention claire, « VSC ON » ou « fin du VSC », d'après ce que le pilote voyait à l'écran. Une commande « VSC ON » reçue alors que le VSC est déjà en cours serait ignorée.

### 3. Vue pilote : deux appuis sur Drapeau rouge relancent la course
- **Ce qui se passe :** même mécanisme d'interrupteur. Le premier pilote met le drapeau rouge, le second (300 ms plus tard) déclenche **la reprise**, et les feux repartent.
- Le second pilote a pourtant confirmé « Drapeau rouge : toutes les voitures s'arrêtent », parce que son écran n'était pas encore à jour.
- **Correction proposée :** des commandes distinctes « drapeau rouge » et « reprise ». Seul l'écran principal, ou une confirmation spéciale, pourrait relancer.

## 🟠 Petits défauts

4. **Arrivée sous VSC :** le drapeau reste sur « VSC » après l'arrivée. Une voiture reste bridée environ 2 s, puis retrouve sa vitesse. La vue pilote et l'écran affichent encore VSC sur une séance terminée. Il faudrait repasser en vert à l'arrivée.
5. **VSC ou drapeau rouge appuyés après l'arrivée :** ils sont bien ignorés, mais aucun message ne le dit.
6. **Calcul automatique de l'essence :** il échoue sur les courses longues. À 300 tours, il dit « Aucun réglage trouvé ». À 500 tours, il dit « Impossible d'obtenir 13 arrêts ». Les crans de 0,5 % sont trop gros pour ces longueurs (détails dans le rapport 2).
7. **Calcul automatique de l'essence, deux cas sans avertissement :**
   - si le **record est trop proche du temps médian** (moins de 0,1 s d'écart), aucun réglage n'est proposé ;
   - si le **« tour avec arrêt au stand » est plus court que le temps médian**, l'arrêt compte 0 s, sans avertissement. C'était le cas sur ta capture (« 0,00 s »). Il faudrait afficher : « le tour avec arrêt doit être plus long que le temps médian ».

## 🟡 Règles à préciser (l'appli fait un choix par défaut, mais tu ne l'as jamais décidé)

| # | Situation | Ce que fait l'appli aujourd'hui | Question à trancher |
|---|---|---|---|
| R1 | Drapeau rouge **pendant un VSC** | À la reprise, la course repart en **vert** et le VSC est perdu | Repartir sous VSC ? |
| R2 | **Panne sèche pendant un VSC** | La voiture à sec roule à la vitesse de panne sèche (cran 4), **plus vite** que le VSC (cran 3) | La vitesse la plus lente des deux doit-elle s'appliquer ? |
| R3 | **VSC automatique, fin automatique** | Le VSC se termine au bout du délai **même si la voiture arrêtée n'est pas repartie** | Attendre que la voiture repasse la ligne ? |
| R4 | **Changement de pilote en pleine course** (même manette) | Le nouveau pilote reprend les tours, l'essence et le **meilleur tour** de l'ancien ; la victoire va au dernier pilote | Course en relais (équipe) ou victoire au pilote qui a le plus roulé ? |
| R5 | **Même pilote sur deux manettes** | Autorisé, classement ambigu | Interdire ? |
| R6 | **Tour bouclé sous VSC en qualification** | Il compte pour la pole | Annuler les tours sous VSC en qualif (comme en F1) ? |
| R7 | **Réglage de vitesse changé par le pilote en pleine course** (vue pilote) | Accepté : on peut passer de 10 à 15 en pleine course | Bloquer les réglages pendant la course ? Seulement au stand ? |
| R8 | **Mode d'essence changé en pleine course** (Réglages) | Appliqué tout de suite aux tours suivants | Figer le mode au départ ? |
| R9 | **Arrivée quand une voiture abandonne** | L'arrivée se fait environ 11 s après le vainqueur, la voiture arrêtée est classée dernière | OK ? |
| R10 | **Arrêt au stand trop court** (moins que le temps de changement de pneus) | Les pneus ne sont pas changés et la crevaison reste, sans message | Prévenir le pilote (« arrêt trop court ») ? |

## ✅ Ce qui a été vérifié et fonctionne

- **Course aux tours** de 5 tours : départ aux feux, tours, arrivée, classement, vitesses rendues.
- **Course au temps** de 30 s : fin du temps, dernier tour, arrivée.
- **Qualification et Essais libres** : départ immédiat, classement au meilleur tour, VSC et drapeau rouge.
- **VSC :**
  - bridage immédiat, avec décompte « Fin de VSC dans… 3, 2, 1, Go » ;
  - débridage seulement au Go ;
  - 10 appuis rapides donnent un VSC propre ;
  - un changement du pourcentage pendant le VSC s'applique tout de suite.
- **Drapeau rouge pendant le décompte de fin de VSC :** décompte annulé, vitesses normales à la reprise.
- **VSC puis drapeau rouge puis reprise :** vitesses normales, la course repart.
- **Voiture posée en pleine course :** elle est ajoutée au classement, reçoit son essence et est bridée par le VSC.
- **Essence :**
  - panne sèche (bridage) ;
  - ravitaillement au stand jusqu'au plein, avec la vitesse rendue ;
  - passage au stand pendant un VSC (la voiture ressort bridée) ;
  - mode Fixe et mode Selon le temps au tour (testés plus tôt) ;
  - réservoir mis à 100 % au départ en mode Selon le temps au tour.
- **VSC automatique par tour :** déclenché environ 7 s après le dernier passage de la voiture arrêtée.
- **Pneus :**
  - crans de chaque gomme, et pneus froids ;
  - crevaison (la voiture passe au cran 3) ;
  - changement au stand vers le Dur (vitesse −2, freinage −2, −1 à froid) ;
  - un arrêt trop court ne change pas les pneus.
- **Quitter une course en plein VSC :** vitesses rendues, séance arrêtée.
- **Un pilote change son réglage pendant le VSC :** la voiture reste bridée.

## ⚪ Pas testé, ou limité par le simulateur

- **Vue pilote réelle** (Firebase, QR code) : le mécanisme a été vérifié en reproduisant exactement la logique des commandes, mais pas avec de vrais téléphones.
- **Reconnexion en pleine course :** le simulateur redémarre à zéro quand on le reconnecte. Sur une vraie CU, la course continue ; c'est à vérifier sur le circuit.
- **Faux départ et appui sur START pendant les feux :** le simulateur ne reproduit pas ce comportement de la vraie CU.
- **Éclairage (rampe, lampes) et voix :** non vérifiés pendant ces essais.
