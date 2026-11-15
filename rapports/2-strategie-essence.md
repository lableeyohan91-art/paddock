# Rapport 2 — Stratégie essence : conclusions et idées d'amélioration

**Circuit de test :** record 3,30 s, temps médian 3,61 s, tour avec arrêt au stand 8,50 s (passage par les stands : +4,89 s). Environ 1 arrêt voulu tous les 40 tours.

**Méthode :** pour chaque longueur de course, je prends le réglage proposé par le calcul automatique. Ensuite je cherche **la meilleure stratégie possible** pour un pilote malin. Il peut répartir ses tours entre deux fourchettes (tous les mélanges sont essayés), et viser soit le **centre** d'une fourchette, soit son **bord rapide** (même consommation, tour plus rapide).

Les scripts d'analyse sont dans le dossier temporaire de la session, ils ne sont pas dans l'appli.

## 1. Résultats avec le système actuel (fourchettes)

Écart avec un pilote qui roule tout le temps au rythme nominal (− = plus rapide que lui) :

| Course | Meilleur mélange (centre) | Meilleur mélange (bord rapide) | 80 % Lent 1 + 20 % nominal | Même nombre de tours dans chaque fourchette |
|---|---|---|---|---|
| 30 tours | −2,8 s (27 tours Rapide 1 + 3 tours Lent 2) | −3,4 s | +1,3 s | +0,4 s |
| 50 tours | −2,6 s (40 R1 + 10 L3) | −5,0 s (tout en nominale, au bord rapide) | +1,5 s | +1,1 s |
| 80 tours | −3,5 s (70 R4 + 10 L3) | −4,5 s | +0,5 s | +3,0 s |
| 100 tours | −4,1 s (tout en Rapide 4) | −7,7 s | +3,7 s | +6,0 s |
| 150 tours | **−12,0 s** (tout en Rapide 3, 6 arrêts au lieu de 4) | −14,2 s | −1,3 s | +8,1 s |
| 200 tours | **−25,2 s** (tout en Rapide 2, 7 arrêts au lieu de 5) | −32,2 s | +4,8 s | +14,0 s |
| 300 tours | calcul impossible | | | |
| 500 tours | calcul impossible | | | |

### Ce que ça veut dire

1. **Ta crainte sur les tours lents est surtout infondée.** Faire 80 % des tours en lent et 20 % en nominal **perd** du temps dans presque tous les cas : de +0,5 à +4,8 s. Seule exception, 150 tours, où l'on gagne 1,3 s en économisant un arrêt. Répartir ses tours dans toutes les fourchettes perd aussi.
2. **Le vrai trou est du côté rapide sur les courses longues.** À partir de 150 tours, rouler tout le temps vite gagne **12 à 32 s**, même avec 2 arrêts de plus. Le calcul vérifie bien l'équilibre, mais il est bridé par les crans de 0,5 % et par la limite « 2 arrêts de plus au maximum ».
3. **Le bord d'une fourchette, c'est du temps gratuit.** Dans une même fourchette, on consomme pareil à 3,50 s qu'à 3,72 s. Un bon pilote qui vise le bas de la fourchette nominale gagne **5 à 8 s** sans aucun coût. Plus une fourchette est large, plus le gain est gros. Ce sont les « marches d'escalier » du barème.
4. **Au-delà de 200 tours, le calcul échoue.** Il faudrait par exemple entre 2,6 et 2,8 % par tour, alors que les crans de 0,5 % n'offrent que 2,5 ou 3 %.

### Ta règle « consommation minimale = 2 fois… »
Je l'ai comprise comme « la consommation des fourchettes lentes ne descend pas sous **la moitié** de la nominale », pour qu'il n'y ait plus de 1 %. Résultat : **elle ne change presque rien**, parce que les tours lents n'étaient pas le problème. Elle reste une bonne idée de bon sens, puisqu'un tour raté consomme quand même. Mais elle ne corrige pas les deux vrais trous : les tours rapides sur les longues courses et le bord des fourchettes.

## 2. Piste d'amélioration testée : consommation continue

Au lieu de 9 fourchettes en escalier, la consommation suit le temps au tour **en continu** :

> **consommation = nominale × (temps médian ÷ temps du tour)^k**

Exemple avec k = 5 et une nominale de 3,2 % : un tour au médian (3,61 s) consomme 3,2 %, un tour au record (3,30 s) consomme 5,0 %, un tour lent (4,00 s) consomme 1,9 %.

Résultats (k et la vitesse de remplissage sont choisis par le calcul) :

| Course | Meilleur mélange possible | Rouler tout le temps au record |
|---|---|---|
| 30 tours | −0,2 s | +5,5 s |
| 50 tours | −0,2 s | +7,5 s |
| 80 tours | −1,8 s | +8,2 s |
| 100 tours | −1,4 s | +9,9 s |
| 150 tours | −2,3 s | +18,2 s |
| 200 tours | −1,9 s | +16,1 s |
| 300 tours | −3,6 s | +26,3 s |
| **500 tours** | −3,3 s | +74,7 s |

- **On ne peut plus exploiter le barème.** Le meilleur gain est de 0,1 à 0,3 % du temps de course, et il consiste simplement à rouler **un poil plus vite que le nominal**. C'est exactement le comportement qu'on veut récompenser.
- **Plus de bord gratuit**, puisqu'il n'y a plus d'escalier.
- **Les tours lents ne paient jamais.**
- **Ça marche de 30 à 500 tours.**
- **Rouler à fond tout le temps coûte cher** : trop d'essence, trop d'arrêts. Le réglage k permet de rendre l'attaque plus ou moins payante.

## 3. Idées d'amélioration, par ordre d'intérêt

1. **Passer en consommation continue**, avec un seul réglage « sensibilité à l'attaque » (k) en plus de la nominale. C'est plus simple à comprendre que 9 fourchettes, plus juste, et ça fonctionne sur toutes les longueurs. On peut garder l'affichage en couleurs (rapide, nominal, lent) pour la lisibilité.
2. **Si on garde les fourchettes :**
   - crans de **0,1 %** au lieu de 0,5 % (règle les 300 et 500 tours) ;
   - fourchettes **plus étroites** autour du nominal (réduit le bord gratuit) ;
   - faire vérifier par le calcul automatique les **mélanges de deux fourchettes** et le **bord rapide** de chaque fourchette, pas seulement les rythmes constants.
3. **Un tour raté (sortie de piste, VSC) ne devrait pas « rapporter » d'essence.** Les tours sous VSC pourraient consommer la nominale, ou un minimum fixe.
4. **Dans le calcul automatique, avertir** si le tour avec arrêt au stand est plus court que le temps médian, et si le record est trop proche du médian.
5. **Montrer au pilote, sur sa vue pilote, la consommation de son dernier tour** et le nombre de tours qu'il peut encore faire. C'est ce qui rend la gestion de l'essence vivante.

## 4. Conclusion

Le système actuel tient bien de **30 à 100 tours** : les écarts restent de quelques secondes, et les rythmes lents ne paient pas. Il a deux défauts :
- le **bord des fourchettes**, qui donne du temps gratuit ;
- les **courses longues** (150 tours et plus), où attaquer tout le temps gagne trop, jusqu'au calcul impossible à 300 et 500 tours.

La **consommation continue** corrige les deux à la fois, sur toutes les longueurs. C'est ce que je recommanderais d'essayer ensuite.
