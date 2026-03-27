import { Kysely, sql } from 'kysely';
import { getConfig } from 'src/config';
import { GithubRepository } from 'src/repositories/github.repository';

const repo = new GithubRepository();

export async function up(db: Kysely<any>): Promise<void> {
  const { github } = getConfig();
  if (github.appId !== 'dev') {
    await repo.init(github.appId, github.privateKey, github.installationId);
  }

  await sql`ALTER TABLE "pull_request" ADD "nodeId" character varying;`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD "organization" character varying;`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD "repository" character varying;`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD "number" integer;`.execute(db);

  for await (const batch of repo.getPullRequests({ org: 'immich-app', repo: 'immich' })) {
    for (const pr of batch) {
      await db.updateTable('pull_request')
        .set({
          nodeId: pr.id,
          organization: 'immich-app',
          repository: 'immich',
          number: pr.number,
        })
        .where('id', '=', pr.fullDatabaseId)
        .execute();
    }
  }

  await sql`ALTER TABLE "pull_request" ALTER COLUMN "nodeId" SET NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" ALTER COLUMN "organization" SET NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" ALTER COLUMN "repository" SET NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" ALTER COLUMN "number" SET NOT NULL;`.execute(db);

  await sql`ALTER TABLE "pull_request" DROP CONSTRAINT "pull_request_pkey";`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_pkey" PRIMARY KEY ("nodeId");`.execute(db);
  await sql`ALTER TABLE "pull_request" DROP COLUMN "id";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "pull_request" DROP CONSTRAINT "pull_request_pkey";`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD "id" bigint NOT NULL;`.execute(db);
  await sql`ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_pkey" PRIMARY KEY ("id");`.execute(db);
  await sql`ALTER TABLE "pull_request" DROP COLUMN "nodeId";`.execute(db);
  await sql`ALTER TABLE "pull_request" DROP COLUMN "organization";`.execute(db);
  await sql`ALTER TABLE "pull_request" DROP COLUMN "repository";`.execute(db);
  await sql`ALTER TABLE "pull_request" DROP COLUMN "number";`.execute(db);
}
