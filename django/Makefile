PLATFORM_PORT ?= 3008

build:
	docker compose build --pull

up:
	docker compose up -d

migrate:
	docker compose run --rm web python manage.py migrate
	docker compose run --rm web python manage.py collectstatic --noinput

superuser:
	docker compose run --rm web python manage.py createsuperuser

sync:
	docker compose run --rm web python manage.py sync_policy_packs /opt/policy-packs
	docker compose run --rm web python manage.py sync_skill_packs /opt/skill-packs
	docker compose run --rm web 
ps:
	docker compose ps

logs:
	docker compose logs -f --tail=100

down:
	docker compose down
