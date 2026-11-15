# Rapport 3 — Stratégie pneus : conclusions, idées et comment les faire

**Modèle étudié :** celui de l'appli (v1.32), avec les réglages d'origine.

| Gomme | Vitesse | Freinage | Usure par tour |
|---|---|---|---|
| Tendre | programmation du pilote | − 0 cran | 4 % |
| Medium | − 1 cran | − 0 cran | 2,5 % |
| Dur | − 2 crans | − 2 crans | 1 % |

Pour toutes les gommes :
- chute de grip au hasard entre 25 et 15 % de santé ; la voiture garde alors 50 % de sa programmation ;
- crevaison possible sous 15 % de santé (20 % de risque par passage), puis sous 7 % (50 % de risque) ;
- pneus froids : 1 cran de moins pendant la chauffe.

**Méthode :** pour chaque longueur (30, 50, 100 tours), chaque programmation (6, 8, 10, 12) et chaque gomme, j'ai simulé **1 500 courses** en tirant au sort la chute de grip et les crevaisons. Pour chaque gomme, j'ai cherché à quel moment il vaut mieux rentrer au stand : à 40 %, 30 %, 26 %, 22 %, 18 %, 14 %, 8 % de santé, jamais, ou dès la chute de grip.

## 1. Résultats avec les réglages actuels

| Course | Programmation 6 | Programmation 8 | Programmation 10 | Programmation 12 |
|---|---|---|---|---|
| 30 tours | Tendre gagne (écart 7,4 %) | Medium (5,7 %) | Medium (5,1 %) | Medium (4,7 %) |
| 50 tours | Tendre (6,3 %) | Tendre (4,5 %) | Tendre (2,9 %) | Tendre (1,5 %) |
| 100 tours | Tendre (7,6 %) | Tendre (5,9 %) | Tendre (4,4 %) | Tendre (3,1 %) |

L'écart indiqué est celui entre la meilleure et la moins bonne gomme.

### Constats

1. **Le Dur ne gagne jamais.** Ses 2 crans de vitesse en moins, et ses 2 crans de freinage, coûtent plus que ce qu'il fait gagner en arrêts. C'est pire quand la programmation est basse : à 6, enlever 2 crans fait perdre un tiers de la vitesse.
2. **Le Tendre écrase tout dès 50 tours.** La meilleure stratégie consiste à rentrer **dès la chute de grip**. L'annonce « pneus usés » sert de signal, et c'est un bon mécanisme de jeu.
3. **Le Medium ne gagne que sur les courses courtes** (30 tours, sans arrêt).
4. **Le hasard pèse très peu.** Les écarts entre la meilleure et la pire course simulée (10 % / 90 %) sont quasi nuls. La chute de grip aléatoire sert surtout à donner le signal de rentrer, et les crevaisons sont rares si on rentre à temps.
5. **Jouer avec le risque de crevaison paie un peu avec le Medium** sur 100 tours. Rouler jusqu'à 14 % de santé est la meilleure stratégie, malgré 0,7 crevaison en moyenne. C'est intéressant pour le jeu, mais l'écart est petit.
6. **Les écarts entre gommes restent trop grands** : 3 à 7,6 %, alors qu'il faudrait autour de 1 à 2 % pour que chaque gomme puisse gagner.

## 2. Le cœur du problème : les crans entiers

La Control Unit ne connaît que 16 crans de vitesse. Avec 0, −1 et −2 crans, il n'y a **que trois niveaux**, et ils sont très éloignés les uns des autres, surtout quand la programmation est basse.

J'ai testé une variante : Dur à −1 cran (et −1 en freinage), Tendre à 5 % d'usure par tour, Medium à 3 %. Résultat : le Dur va alors **aussi vite que le Medium** tout en s'usant moins, et c'est lui qui gagne presque partout. **On passe d'un extrême à l'autre** : il manque un niveau entre les deux.

## 3. Idées d'amélioration, et comment les faire

### Idée A — Le « demi-cran » par alternance (la plus importante)
- **Le principe :** pour obtenir un cran intermédiaire, par exemple 8,5 entre 8 et 9, l'appli alterne la vitesse envoyée à la voiture. Elle envoie 9, puis 8, toutes les 1 à 2 secondes. En moyenne, la voiture roule à « 8,5 ».
- **Comment :** le moteur de performance calcule déjà une vitesse décimale avant de l'arrondir. Au lieu d'arrondir, on alterne entre les deux crans voisins, selon la partie décimale, dans la boucle de 200 ms qui renvoie déjà les vitesses pendant le VSC.
- **Ce que ça permet :** Tendre à 100 %, Medium à 93 %, Dur à 86 % de la programmation de **chaque** pilote, quel que soit son réglage. C'est exactement ce que tu voulais au départ (« un pourcentage de la programmation »), sans la limite des crans entiers.
- **À vérifier sur le circuit :** que l'alternance ne se sente pas trop dans la main. On peut régler la cadence.

### Idée B — Rendre le Dur utile autrement que par la vitesse
- Dur à −1 cran **sans** pénalité de freinage, mais **chauffe plus longue** (3 tours froids au lieu de 2) et usure très lente.
- Ou bien : **le Dur ne crève jamais** et sa chute de grip est plus douce (70 % au lieu de 50 %).

### Idée C — Une usure qui dépend du pilotage
- Comme l'essence : plus le tour est rapide par rapport au temps médian du pilote, plus le pneu s'use. Un pilote qui ménage ses pneus peut faire un relais de plus.
- **Comment :** dans `wearLap`, multiplier l'usure par un facteur calculé sur le temps du tour, avec la même formule que la consommation continue proposée pour l'essence.
- Ça crée enfin un vrai **choix de rythme**, qui manque aujourd'hui puisque les pneus imposent leur vitesse.

### Idée D — Faire marcher pneus et essence ensemble
- Aujourd'hui, un arrêt essence et un changement de pneus se font dans le même passage au stand. Le remplissage dure souvent plus longtemps que le changement de pneus, qui devient donc **gratuit**.
- **Idée :** additionner les deux temps (remplir **puis** changer), ou interdire de changer les pneus pendant qu'on remplit. Chaque arrêt devient un choix : essence seule, pneus seuls, ou les deux.

### Idée E — Rendre la chute de grip plus progressive
- Au lieu de tomber d'un coup à 50 %, la vitesse baisse d'un cran tous les 2 tours après la chute. Le pilote sent ses pneus partir et doit choisir entre rentrer tout de suite ou tenir encore deux tours.

### Idée F — Une règle de jeu « deux gommes obligatoires »
- Comme en F1 : en course, chaque pilote doit utiliser au moins **deux gommes différentes**, sinon pénalité de temps à l'arrivée.
- C'est très simple à faire (on garde la liste des gommes utilisées par voiture), et ça force les stratégies même si l'équilibre n'est pas parfait.

## 4. Ce que je ferais, dans l'ordre

1. **Idée A (demi-cran).** C'est elle qui débloque l'équilibre fin. Ensuite, refaire tourner l'outil d'équilibrage (`tools/pneus.mjs`) avec des pourcentages au lieu de crans.
2. **Idée F (deux gommes obligatoires)**, en option dans la préparation de course. Simple et efficace pour le jeu.
3. **Idée D (pneus et essence additionnés)**, pour que chaque arrêt soit un vrai choix.
4. **Idées C et E** dans un second temps, pour la profondeur de jeu.

## 5. Conclusion

Le modèle actuel fonctionne techniquement : crans, chauffe, chute de grip, crevaison et changement au stand ont été vérifiés au simulateur. Mais **il n'est pas équilibré**. Le Tendre domine, et le Dur ne sert à rien. La cause principale, ce sont les **crans entiers** de la Control Unit, beaucoup trop gros pour faire des écarts fins entre gommes. Le « demi-cran » par alternance est la clé pour régler ça. Ensuite, la règle des deux gommes obligatoires et le couplage avec l'essence donneront de vraies stratégies.
