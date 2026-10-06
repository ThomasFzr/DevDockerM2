# TD3 — Partie A : à la main (sans Compose)

Valeurs choisies : base `visites`, utilisateur `visites`, mot de passe `visites-pwd`.

## A1 — Lancer l'application conteneur par conteneur

### 1. L'image de l'API (cible `prod`)

```bash
cd td3/app
docker build --target prod -t td3-api:prod .
docker images td3-api
# td3-api:prod   8b4a1c3e2548   266MB   66.2MB
```

### Premier essai : sans réseau

```bash
docker volume create td3-pgdata
docker run -d --name db \
  -e POSTGRES_DB=visites -e POSTGRES_USER=visites -e POSTGRES_PASSWORD=visites-pwd \
  -v td3-pgdata:/var/lib/postgresql postgres:18-alpine
docker logs db | tail -1
# ... LOG:  database system is ready to accept connections

docker run -d --name cache redis:8-alpine

docker run -d --name api -p 3000:3000 \
  -e DB_HOST=db -e DB_NAME=visites -e DB_USER=visites -e DB_PASSWORD=visites-pwd \
  -e REDIS_URL=redis://cache:6379 td3-api:prod
```

L'API s'arrête tout de suite :

```bash
docker ps -a --filter name=api      # api   Exited (1) 2 seconds ago
docker logs api
# Connecting to Postgres at db:5432…
# Error: getaddrinfo ENOTFOUND db
#   code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'db'
```

**Erreur :** `ENOTFOUND db`. Le nom `db` ne correspond à aucune adresse. Sans option `--network`, les trois conteneurs
sont sur le réseau `bridge` **par défaut**, et ce réseau ne fait **pas** de résolution DNS par nom de conteneur.
L'API ne peut donc pas trouver `db` (ni `cache`).

**Correction :** créer un réseau et y brancher les **trois** conteneurs (`--network td3-net`). Sur un réseau créé,
Docker fait office de DNS : `db` et `cache` se résolvent en l'IP du conteneur correspondant.

### Version corrigée

```bash
docker rm -f api db cache
docker network create td3-net
```

**2. Postgres** (volume nommé) :

```bash
docker run -d --name db --network td3-net \
  -e POSTGRES_DB=visites -e POSTGRES_USER=visites -e POSTGRES_PASSWORD=visites-pwd \
  -v td3-pgdata:/var/lib/postgresql postgres:18-alpine
docker logs db | tail -1
# ... LOG:  database system is ready to accept connections
```

**3. Redis :**

```bash
docker run -d --name cache --network td3-net redis:8-alpine
```

**4. L'API :**

```bash
docker run -d --name api --network td3-net -p 3000:3000 \
  -e DB_HOST=db -e DB_NAME=visites -e DB_USER=visites -e DB_PASSWORD=visites-pwd \
  -e REDIS_URL=redis://cache:6379 td3-api:prod

docker logs api
# Connecting to Postgres at db:5432…
# Connecting to Redis at redis://cache:6379…
# Visites API listening on 3000

docker ps
# api     Up   0.0.0.0:3000->3000/tcp
# cache   Up   6379/tcp
# db      Up   5432/tcp
```

Seule l'API publie un port. `db` et `cache` ne sont joignables que depuis le réseau `td3-net`.

## A2 — Supprimer et recréer les trois conteneurs

```bash
curl localhost:3000   # {"hitsInRedis":1,"visitsInPostgres":1,"servedBy":"4c5b457fb991"}
curl localhost:3000   # {"hitsInRedis":2,"visitsInPostgres":2,"servedBy":"4c5b457fb991"}
curl localhost:3000   # {"hitsInRedis":3,"visitsInPostgres":3,"servedBy":"4c5b457fb991"}

docker rm -f api db cache
# … mêmes trois docker run que ci-dessus …

curl localhost:3000   # {"hitsInRedis":1,"visitsInPostgres":4,"servedBy":"bfcfe3cb473e"}
```

- **Postgres a survécu** : 4 visites, la suite des 3 précédentes. Ses données sont écrites dans
  `/var/lib/postgresql`, où est monté le volume nommé `td3-pgdata`. Un volume vit indépendamment des conteneurs :
  `docker rm` ne le supprime pas, et le nouveau `db` retrouve les fichiers de la base.
- **Redis est reparti à 1** : aucun volume n'est monté sur son dossier de données. Ses données étaient dans le
  conteneur (sa couche inscriptible et un volume anonyme), qui a été supprimé. Le nouveau conteneur `cache` part
  d'un Redis vide.

Le `servedBy` a changé aussi : c'est le hostname du conteneur, et le conteneur `api` est nouveau.

## Ménage

```bash
docker rm -f api db cache
docker network rm td3-net
docker volume rm td3-pgdata
```
