-- Default facility and pharmacies. Safe to re-run (idempotent on name/short_code).
insert into public.facilities (name, short_code, notes)
values ('Heartland', 'HRTLD', 'Default facility')
on conflict (short_code) do nothing;

insert into public.pharmacies (name)
select 'Lawrence House' where not exists (select 1 from public.pharmacies where name = 'Lawrence House');
insert into public.pharmacies (name)
select 'Blue Swan' where not exists (select 1 from public.pharmacies where name = 'Blue Swan');
insert into public.pharmacies (name)
select 'Third Coast' where not exists (select 1 from public.pharmacies where name = 'Third Coast');

insert into public.pharmacy_facilities (pharmacy_id, facility_id)
select p.id, f.id
from public.pharmacies p, public.facilities f
where f.short_code = 'HRTLD'
  and p.name in ('Lawrence House', 'Blue Swan', 'Third Coast')
on conflict do nothing;
