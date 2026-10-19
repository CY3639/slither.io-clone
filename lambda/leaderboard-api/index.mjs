// Lambda entrypoint: n5528712-a3-leaderboard-api (ALB Lambda target).
import { createDocClient, DynamoStore } from '../lib/dynamoStore.mjs';
import { createApiHandler } from './handler.mjs';

const store = new DynamoStore({ doc: createDocClient(process.env.AWS_REGION), tableName: process.env.TABLE_NAME });

export const handler = createApiHandler({ store });
