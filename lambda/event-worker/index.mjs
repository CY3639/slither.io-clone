// Lambda entrypoint: n5528712-a3-event-worker (SQS event source mapping).
import { createDocClient, DynamoStore } from '../lib/dynamoStore.mjs';
import { createHandler } from './handler.mjs';

const store = new DynamoStore({ doc: createDocClient(process.env.AWS_REGION), tableName: process.env.TABLE_NAME });

export const handler = createHandler({ store });
