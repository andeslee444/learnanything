CREATE UNIQUE INDEX "lessons_one_generating_per_track" ON "lessons" USING btree ("track_id") WHERE "lessons"."status" = 'generating';
