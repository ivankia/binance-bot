import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

let LOCAL_ENVIRONMENT_LOADED = false;

if (
    'production' !== process.env.NODE_ENV &&
    !process.env.LOCAL_ENVIRONMENT_LOADED &&
    fs.existsSync(path.resolve(process.cwd(), '.env'))
) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env') });
    LOCAL_ENVIRONMENT_LOADED = true;
}

const ENVIRONMENT: string = LOCAL_ENVIRONMENT_LOADED ? 'local' : 'gitlab';

export default ENVIRONMENT;
