ALTER TABLE "media_objects" ADD COLUMN "gallery_form_id" TEXT;
ALTER TABLE "media_objects" ADD COLUMN "gallery_field_id" TEXT;
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_gallery_form_id_fkey"
  FOREIGN KEY ("gallery_form_id") REFERENCES "forms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
