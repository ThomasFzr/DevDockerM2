# TD1 — Réponses

Environnement : macOS (Apple Silicon), Docker Desktop, Docker Engine 29.4.0 (client et serveur).

---

## Partie A — Premiers conteneurs

### A1

```bash
docker run hello-world
docker run hello-world
```

Normalement, la première exécution commence par :

```
Unable to find image 'hello-world:latest' locally
latest: Pulling from library/hello-world
...
Status: Downloaded newer image for hello-world:latest
```

puis affiche « Hello from Docker! ». La seconde affiche directement le message, sans téléchargement.

Sur ma machine, l'image `hello-world` était déjà présente quand j'ai commencé (`docker system df` indiquait 1 image), donc
aucune des deux exécutions n'a téléchargé quoi que ce soit. On voit le même mécanisme un peu plus loin avec
`alpine` en B1 : « Unable to find image 'alpine:latest' locally » au premier lancement, rien ensuite.

**Pourquoi :** `docker run` cherche d'abord l'image dans le stockage local du démon. Si elle n'y est pas, il la *pull*
depuis le registry (Docker Hub par défaut), puis crée et démarre le conteneur. Les lancements suivants réutilisent
l'image locale. Chaque `run` crée quand même un **nouveau** conteneur : `docker ps -a` en liste deux, arrêtés
(`Exited (0)`).

### A2

```bash
docker run -d --name web1 -p 8080:80 nginx:1.29-alpine
docker run -d --name web2 -p 8081:80 nginx:1.29-alpine
docker ps
# web1  0.0.0.0:8080->80/tcp
# web2  0.0.0.0:8081->80/tcp
```

**Pourquoi pas de conflit :** chaque conteneur a son propre *network namespace*, avec sa propre interface et sa propre
IP. Le port 80 de `web1` et celui de `web2` sont dans deux piles réseau différentes, comme deux machines distinctes.
Le seul endroit partagé, c'est l'hôte : `-p 8080:80` dit à Docker « redirige le port 8080 **de l'hôte** vers le
port 80 **du conteneur** ». Comme 8080 et 8081 sont différents côté hôte, il n'y a pas de conflit.

**Si on publie `web2` aussi sur 8080** (essayé avec un `web3`) :

```bash
docker run -d --name web3 -p 8080:80 nginx:1.29-alpine
# docker: Error response from daemon: ... Bind for 0.0.0.0:8080 failed: port is already allocated
```

La commande échoue (code 125). Un port de l'hôte ne peut être pris que par un seul conteneur. Détail : le conteneur
est quand même **créé** (`docker ps -a` → `web3  Created`), mais il ne démarre pas. Il faut donc le supprimer
(`docker rm web3`).

### A3

```bash
docker logs web1        # tout ce qui a déjà été écrit
docker logs -f web1     # suivi en continu (Ctrl+C pour quitter)
```

Résultat (une ligne par rafraîchissement) :

```
192.168.215.1 - - [06/Oct/2026:07:35:44 +0000] "GET / HTTP/1.1" 200 896 "-" "curl/8.7.1" "-"
```

**D'où elles viennent :** ce sont les logs d'accès de nginx. `docker logs` n'affiche que ce que le processus principal
écrit sur **stdout/stderr**. L'image nginx officielle redirige ses fichiers de log vers ces sorties :

```bash
docker exec web1 ls -l /var/log/nginx/
# access.log -> /dev/stdout
# error.log  -> /dev/stderr
```

Docker capture ces flux et les stocke. L'IP `192.168.215.1` est la passerelle du réseau Docker (la VM de
Docker Desktop), pas l'IP réelle du navigateur.

### A4

```bash
docker exec -it web1 sh
# dans le conteneur :
echo Thomas > /usr/share/nginx/html/index.html
exit
```

http://localhost:8080 affiche « Thomas ». Ensuite :

```bash
docker rm -f web1
docker run -d --name web1 -p 8080:80 nginx:1.29-alpine
```

La page est revenue à « Welcome to nginx! ».

**Où est passée la modification :** elle avait été écrite dans la **couche inscriptible du conteneur**, au-dessus des
couches de l'image, qui sont en lecture seule. `docker rm` supprime le conteneur et sa couche avec lui. Le nouveau
`web1` repart de l'image intacte.

**Conclusion :** `docker exec` sert à **observer et déboguer** (lire une config, tester une commande), pas à modifier
une application. Une modification faite à la main n'est ni versionnée ni reproductible, et elle est perdue à la
suppression du conteneur. Pour changer durablement le contenu, il faut changer l'image (Dockerfile), ou monter les
fichiers depuis l'extérieur (volume / bind mount).

---

## Partie B — Variables d'environnement et mode interactif

### B1

```bash
docker run --rm -e PRENOM=Thomas alpine printenv PRENOM   # affiche : Thomas   (code 0)
docker run --rm alpine printenv PRENOM                    # n'affiche rien      (code 1)
echo $PRENOM                                              # ligne vide sur l'hôte
```

- Avec `-e` : `Thomas` s'affiche.
- Sans `-e` : rien ne s'affiche, et `printenv` sort avec le code 1 (variable introuvable).
- Sur ma machine, `PRENOM` n'existe pas : `echo $PRENOM` affiche une ligne vide.

**Où vit la variable :** uniquement dans l'environnement du **processus du conteneur**. Docker la passe au processus
principal au démarrage. Elle n'est pas définie dans le shell de l'hôte, et elle n'est pas écrite dans l'image. Elle
disparaît avec le conteneur (ici tout de suite, à cause de `--rm`).

### B2

```bash
docker run --rm -it alpine sh
# dans le conteneur :
apk add curl
curl -sI https://example.com | head -1     # HTTP/2 200 → curl fonctionne
exit

docker run --rm -it alpine sh
# dans le nouveau conteneur :
which curl                                 # rien : curl absent
```

**curl n'est plus là.** L'installation a été faite dans la **couche inscriptible du premier conteneur**, pas dans
l'image `alpine`. Avec `--rm`, ce conteneur et sa couche ont été supprimés à la sortie. La seconde commande crée un
**nouveau** conteneur à partir de l'image `alpine` d'origine, qui ne contient pas curl.

---

## Partie C — Images et couches

### C1

```bash
docker pull node:24 && docker pull node:24-slim && docker pull node:24-alpine
docker image ls node
docker run --rm node:24 sh -c 'ls /usr/bin | wc -l'
docker run --rm node:24 which gcc git curl
# (idem pour node:24-slim et node:24-alpine)
```

| Image            | Taille sur disque | Taille téléchargée | Commandes dans `/usr/bin` | gcc | git | curl |
|------------------|------------------:|-------------------:|--------------------------:|:---:|:---:|:----:|
| `node:24`        | 1,64 Go           | 419 Mo             | 664                       | oui | oui | oui  |
| `node:24-slim`   | 349 Mo            | 83,3 Mo            | 273                       | non | non | non  |
| `node:24-alpine` | 237 Mo            | 62,4 Mo            | 143                       | non | non | non  |

Les trois font tourner exactement le même Node (`node -v` → `v24.21.0`).

**Ce que la plus grosse contient en plus :** `node:24` est basée sur une Debian complète, avec toute une chaîne de
compilation et d'outils de développement : `gcc`/`make` (pour compiler des modules natifs), `git`, `curl`, des
en-têtes de bibliothèques, etc. `slim` est une Debian réduite au minimum, et `alpine` part d'une distribution très
légère (musl + busybox).

**Utile pour faire tourner une API ?** Non. Pour *exécuter* l'API, il suffit de Node et des `node_modules`. Les
compilateurs et `git` ne servent qu'au moment de *construire*, éventuellement. En production, ils ne font que
grossir l'image (téléchargement, stockage) et ajouter de la surface d'attaque (plus de paquets, donc plus de CVE
potentielles). D'où l'intérêt d'une image légère pour l'exécution, et du build multi-stage.

### C2

```bash
docker image history node:24-alpine
```

```
SIZE     CREATED BY
0B       CMD ["node"]
0B       ENTRYPOINT ["docker-entrypoint.sh"]
4.1kB    COPY docker-entrypoint.sh /usr/local/bin/
5.43MB   RUN /bin/sh -c apk add --no-cache --virtual .build-deps-yarn curl gnupg tar ... (installe yarn)
0B       ENV YARN_VERSION=1.22.22
158MB    RUN /bin/sh -c addgroup -g 1000 node && adduser ... && apk add --no-cache libstdc++ ... (installe Node)
0B       ENV NODE_VERSION=24.21.0
0B       CMD ["/bin/sh"]
10.3MB   ADD alpine-minirootfs-3.24.2-aarch64.tar.gz /
```

- **9 lignes** dans l'historique, mais seulement **4 vraies couches de fichiers** (`ADD`, les deux `RUN`, le `COPY`),
  ce que confirme `docker image inspect node:24-alpine --format '{{len .RootFS.Layers}}'` → `4`. Les lignes à 0 B
  (`ENV`, `CMD`, `ENTRYPOINT`) ne modifient que des métadonnées.
- **La plus lourde (158 Mo)** vient du `RUN` qui crée l'utilisateur `node` et installe Node.js (binaire + dépendances
  comme `libstdc++`). Le système Alpine de base ne pèse que 10,3 Mo.

### C3

```bash
docker image inspect nginx:1.29-alpine --format '{{json .Config.Cmd}} {{json .Config.ExposedPorts}}'
```

```
Cmd          = ["nginx", "-g", "daemon off;"]
Entrypoint   = ["/docker-entrypoint.sh"]
ExposedPorts = {"80/tcp": {}}
```

- **Commande au démarrage :** `nginx -g "daemon off;"`, passée en argument à l'entrypoint `/docker-entrypoint.sh`.
  `daemon off;` est important : nginx reste au premier plan. S'il passait en arrière-plan, le processus principal
  se terminerait et le conteneur s'arrêterait aussitôt.
- **Port indiqué :** `80/tcp`.
- **Cohérent avec A2 :** oui. On a publié `-p 8080:80` et `-p 8081:80`, toujours vers le port 80 du conteneur, celui
  où nginx écoute. `EXPOSE`/`ExposedPorts` ne fait que *documenter* ce port. C'est `-p` qui le publie réellement.

---

## Partie D — Énigmes

### D1 — `docker run -d alpine` : rien dans `docker ps`

**Observation :**

```bash
docker run -d alpine          # affiche un ID et rend la main
docker ps                     # vide
docker ps -a                  # d1  "/bin/sh"  Exited (0) 1 second ago
docker image inspect alpine --format '{{json .Config.Cmd}}'   # ["/bin/sh"]
```

**Explication :** le `Cmd` par défaut d'`alpine` est `/bin/sh`. Lancé avec `-d` et sans `-it`, ce shell n'a pas
d'entrée standard ouverte : il lit EOF, n'a rien à faire et se termine tout de suite avec le code 0. Un conteneur vit
tant que son processus principal vit, donc il passe aussitôt à `Exited (0)`. `docker ps` n'affiche que les
conteneurs en cours. Il faut `docker ps -a` pour le voir.

**Correction :** lui donner un processus qui dure.

```bash
docker run -dit alpine                 # shell avec stdin ouvert et TTY : il attend → reste Up
docker run -d alpine sleep infinity    # ou une commande longue explicite
```

Vérifié : `docker run -dit --name d1fix alpine` → `docker ps` affiche `d1fix  Up`.
En pratique, on lance plutôt la *vraie* commande voulue, ou on utilise `docker run --rm -it alpine sh` pour un shell
interactif.

### D2 — `-p 9082:8080` : le conteneur tourne mais la page ne répond pas

**Observation :**

```bash
docker run -d -p 9082:8080 nginx:1.29-alpine
curl localhost:9082        # curl: (52) Empty reply from server
docker port <id>           # 8080/tcp -> 0.0.0.0:9082
```

**Explication :** la syntaxe est `-p PORT_HÔTE:PORT_CONTENEUR`. Ici, on redirige 9082 de l'hôte vers le port **8080
du conteneur**. Or nginx écoute sur le port **80** (cf. `ExposedPorts` en C3). La redirection existe bien, mais rien
n'écoute de l'autre côté, d'où la réponse vide. Docker ne vérifie pas que le port cible est réellement utilisé.

**Correction :**

```bash
docker run -d -p 9082:80 nginx:1.29-alpine
```

Vérifié (sur 9083 pour ne pas supprimer le premier) : `curl localhost:9083` → `200`.

### D3 — L'arrêt lent de `dormeur`

```bash
docker run -d --name dormeur alpine sleep 1000
time docker stop dormeur                       # ≈ 10,17 s
docker ps -a --filter name=dormeur             # Exited (137)
```

**Observation :** l'arrêt prend **environ 10 secondes** (10,17 s chez moi), et le code de sortie est **137**.

**Explication** (slide « Cycle de vie » : *stop = demande l'arrêt, puis force après un délai*) :

1. `docker stop` envoie d'abord **SIGTERM** au processus principal (PID 1 du conteneur) pour lui demander de
   s'arrêter proprement.
2. `sleep` ne réagit pas. En tant que PID 1, il n'a pas de gestionnaire pour SIGTERM, et le noyau ignore ce signal
   pour le PID 1 dans ces conditions.
3. Docker attend le délai de grâce, **10 s** par défaut (`--time` / `-t` pour le changer).
4. Passé ce délai, Docker envoie **SIGKILL**, qui ne peut pas être ignoré, et le processus est tué.

**137 = 128 + 9**, où 9 est le numéro de SIGKILL : le processus a été tué de force, il ne s'est pas arrêté
proprement.

**Bonus — avec `--init` :**

```bash
docker run -d --init --name dormeur2 alpine sleep 1000
time docker stop dormeur2                      # ≈ 0,09 s
docker ps -a --filter name=dormeur2            # Exited (143)
```

L'arrêt devient **quasi instantané** et le code passe à **143 = 128 + 15** (15 = SIGTERM). Avec `--init`, Docker
place un petit init (`tini`) en PID 1. C'est lui qui reçoit SIGTERM et le transmet à `sleep`. Comme `sleep` n'est
plus PID 1, le comportement par défaut du signal s'applique et il se termine aussitôt. On obtient un arrêt propre au
lieu d'un kill forcé après 10 s.

### D4 — `gourmand` et la limite mémoire

```bash
docker run --name gourmand --memory 50m node:24-alpine \
  node -e "const a=[]; while(true) a.push(new Array(1e6).fill(1))"
echo $?                                                    # 137
docker inspect gourmand --format '{{.State.OOMKilled}} {{.State.ExitCode}} {{.HostConfig.Memory}}'
# true 137 52428800
```

**Observation :** le programme alloue de la mémoire en boucle, et le conteneur s'arrête brutalement au bout d'environ
1 seconde, sans message d'erreur de Node. Code de sortie : **137** (128 + 9 → SIGKILL).

**Confirmation :** dans `docker inspect gourmand`, le champ **`State.OOMKilled`** vaut **`true`**.
`HostConfig.Memory` vaut `52428800` octets, soit 50 Mio.

**Mécanisme :** ce sont les **cgroups**, le mécanisme du noyau qui contrôle *ce qu'un processus peut consommer*.
`--memory 50m` fixe la limite `memory.max` du cgroup du conteneur. Quand le processus la dépasse, l'**OOM killer** du
noyau tue le processus avec SIGKILL. Le reste de la machine n'est pas affecté. (Les *namespaces*, eux, contrôlent ce
que le processus *voit*.)

---

## Partie E — Ménage

### E1

**Espace avant** (fin du TD) :

```bash
docker system df
```

```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          6         4         2.321GB   1.988GB (85%)
Containers      13        5         1.929MB   770kB (39%)
Local Volumes   0         0         0B        0B
Build Cache     0         0         0B        0B
```

Docker occupait **≈ 2,32 Go**, presque entièrement en images (surtout `node:24`, 1,64 Go). Il y avait 13 conteneurs :
5 en cours d'exécution, 8 arrêtés.

**Nettoyage :**

```bash
docker rm -f web1 web2 d1fix d2 d2fix   # arrêter et supprimer ceux qui tournaient encore
docker container prune -f               # supprimer tous les conteneurs arrêtés
# Deleted Containers: ... (8)
# Total reclaimed space: 770kB
```

**Espace après :**

```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          6         0         2.319GB   2.312GB (99%)
Containers      0         0         0B        0B
```

Les conteneurs ne pesaient presque rien (≈ 2 Mo au total, 770 ko récupérés par le `prune`). Ils ne contiennent que
leur couche inscriptible. L'essentiel de la place est occupé par les **images**, maintenant inutilisées à 99 %. Pour
récupérer cet espace, on peut faire `docker image prune -a` (ou `docker rmi node:24 ...`), ou `docker system prune -a`
pour tout ce qui ne sert plus. Je garde les images pour le TD2.
