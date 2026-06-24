-- Fuerza de selecciones (rating Elo, ajustable). Nombres = openfootball.
insert into team_strength (name, rating) values
  ('Argentina',2100),('France',2080),('Spain',2070),('England',2040),('Brazil',2030),
  ('Portugal',2010),('Netherlands',1990),('Belgium',1970),('Germany',1965),('Croatia',1930),
  ('Uruguay',1925),('Colombia',1910),('Morocco',1900),('Canada',1810),('Turkey',1800),
  ('USA',1860),('Switzerland',1855),('Japan',1850),('Senegal',1845),('Mexico',1840),
  ('Ecuador',1820),('Austria',1815),('Australia',1790),('South Korea',1785),('Sweden',1780),
  ('Ivory Coast',1770),('Norway',1765),('Egypt',1760),('Bosnia & Herzegovina',1760),
  ('Iran',1755),('Paraguay',1750),('Scotland',1745),('Ghana',1740),('Tunisia',1730),
  ('DR Congo',1715),('Saudi Arabia',1710),('Qatar',1700),('South Africa',1700),
  ('Czech Republic',1790),('Panama',1700),('Iraq',1690),('Uzbekistan',1685),
  ('Cape Verde',1670),('Jordan',1660),('New Zealand',1650),('Curaçao',1630),
  ('Haiti',1620),('Algeria',1775)
on conflict (name) do update set rating = excluded.rating;
