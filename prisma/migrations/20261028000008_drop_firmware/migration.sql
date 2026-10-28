-- Server Settings → Repository removed: the firmware image repository
-- (20261028000007_settings_firmware) has no place in Charon. Its partial
-- unique indexes and CHECKs go with the tables. Image bytes under
-- data/firmware are not touched; delete that directory by hand if present.

DROP TABLE IF EXISTS "firmware_credential_bindings";
DROP TABLE IF EXISTS "firmware_images";
