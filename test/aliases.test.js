const crypto = require('crypto');
const chai = require('chai');

const should = chai.should();
const { request } = require('./test-helper');
const { runGsuiteOperation, gsuiteOperations } = require('../lib/google-suite');
const redis = require('../lib/redis').db;

function delay(interval) {
    return it('should delay', (done) => { setTimeout(() => done(), interval); },).timeout(interval + 100); // The extra 100ms should guarantee the test will not fail due to exceeded timeout
}


async function safeDeleteUser(deleteUserFn, getUserFn, { retries = 5, delayMs = 3000 } = {}) {
  console.log("[SAFE DELET] Safely deleting user");
  for (let i = 0; i < retries; i++) {
    try {
      // 1. Try to delete
      result = await deleteUserFn();
      console.log("[SAFE DELET] Result from Google: "); 
      console.log(result);
      if ( result.success == true) return;
      // 2. Wait to ensure it's actually gone
      await waitForUserDeleted(getUserFn);
      return;
    } catch (err) {
      const msg = err.message || "";
      
      // If the backend says "not complete," it's not ready to delete yet.
      if (msg.includes("User creation is not complete") && i < retries - 1) {
        console.log(`[SAFE DELET] Cleanup Attempt ${i + 1} failed: Backend busy. Retrying...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      
      // If it's a 404, it's already gone, which is a success for cleanup!
      if (err.response?.status === 404) return;

      if (i === retries - 1) throw err;
    }
  }
}

/**
 * Polling function to wait for a user to become available.
 * Resolves if status is 200. Retries if status is 404/409.
 */
async function waitForUserReady(getUserFn, { retries = 5, delayMs = 2121 } = {}) {
  console.log("[WAIT_FOR_USER] Is the user already created?");
  for (let i = 0; i < retries; i++) {
    try {
      await getUserFn();
      console.log("[WAIT_FOR_USER] User is ready!");
      return; 
    } catch (err) {
      // 1. Capture the error details
      const status = err.response?.status;
      const message = err.message || "";
      
      // 2. Define what a "Retryable" error looks like
      // We check for 404 status OR the specific string you're seeing
      const isNotFound = status === 404 || message.includes("Resource Not Found");
      const isNotComplete = message.includes("User creation is not complete");

      console.log(`[WAIT_FOR_USER] Attempt ${i + 1}/${retries} failed: ${message}.`);

      // 3. Decide whether to stop or keep going
      const shouldRetry = (isNotFound || isNotComplete) && i < retries - 1;

      if (!shouldRetry) {
        console.error("[WAIT_FOR_USER] Stopping retries. Final Error:", message);
        throw err; // This is where it exits if it thinks it shouldn't retry
      }

      // 4. Wait for the next round
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Polling function to wait for a user to be deleted.
 * Resolves only when the API returns a 404 or 410.
 */
async function waitForUserDeleted(getUserFn, { retries = 5, delayMs = 2211 } = {}) {
  console.log("[WAIT_FOR_DELETION] Has the user been properly deleted?");
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`waitForUserDeleted attempt: ${i}`);
      
      // Capture the result to see WHY it still exists
      const user = await getUserFn();

      if (!user) { // If the API returns null or undefined
        console.log("[WAIT_FOR_DELETION] Success: User record is null (deleted).");
        return;
      }
      
    } catch (err) {
      const status = err.response?.status;
      const message = err.message || "";

      // Success: 404 means it's gone
      if (status === 404 || status === 410 || message.includes("Resource Not Found")) {
        console.log("[WAIT_FOR_DELETION] Success: User is no longer found.");
        return;
      }

      // Real error: If it's a 500 or Auth error, stop immediately
      console.error(`[WAIT_FOR_DELETION] Polling encountered an error: ${message}`);
      throw err;
    }

    // Wait and retry if user was found
    if (i < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error('[WAIT_FOR_DELETION] User still exists after 5 attempts. Check if the delete command was actually accepted.');
}

describe('Aliases', () => {
    const name = 'Automated';
    const surname = 'APITest';
    const generatedUsername = name.toLowerCase() + '.' + surname.toLowerCase() + '@aegee.eu';
    const email = 'alternatemail817263@mailinator.com';
    const antenna = 'AEGEE-Tallahassee';
    const password = 'AEGEE-Europe';
    const SHA1Password = crypto.createHash('sha1').update(JSON.stringify(password)).digest('hex');
    const userPK = 'totallyuuid-account';
    const userAlias = 'alias_for_user_test@aegee.eu';
    const otherAlias = 'other_alias_for_test@aegee.eu';

    const accountData = {
        primaryEmail: generatedUsername,
        name: {
            givenName: name,
            familyName: surname,
        },
        password: SHA1Password,
        hashFunction: 'SHA-1',
        emails: [
            {
                address: email,
                type: 'home',
                customType: '',
                primary: true,
            },
        ],
        organizations: [
            {
                department: antenna,
            },
        ],
        orgUnitPath: '/individuals',
        includeInGlobalAddressList: true,
    };

    const data = {
        operation: 'add',
        aliasName: userAlias,
    };

    before('add the user', async function () {
        this.timeout(8000);
        const result = await runGsuiteOperation(gsuiteOperations.addAccount, accountData);
        console.log(result);

        const userPrimaryEmail = generatedUsername;
        const userSecondaryEmail = email;

        // user
        redis.hset('user:' + userPK, 'GsuiteAccount', userPrimaryEmail, 'SecondaryEmail', userSecondaryEmail);
        redis.set('primary:' + userPK, userPrimaryEmail);
        redis.set('primary:' + userSecondaryEmail, userPrimaryEmail);
        redis.set('id:' + userPrimaryEmail, userPK);
        redis.set('secondary:' + userPrimaryEmail, userSecondaryEmail);
    });

//    after('Remove user', async function () {
//        this.timeout(8000);
//
//        let keys = await redis.keys('*');
//        console.log(keys);
//
//        // Penso che il problema sia qui.
//        const result = await runGsuiteOperation(gsuiteOperations.deleteAccount, accountData);
//        console.log(result);
//
//        const userPrimaryEmail = generatedUsername;
//        const userSecondaryEmail = email;
//
//        const pip = redis.pipeline();
//
//        // user
//        pip.hdel('user:' + userPK, 'GsuiteAccount');
//        pip.hdel('user:' + userPK, 'SecondaryEmail');
//        pip.del('primary:' + userPK, 'primary:' + userSecondaryEmail, 'id:' + userPrimaryEmail, 'secondary:' + userPrimaryEmail);
//        pip.srem('alias:' + userPK, otherAlias); // this to remove *from redis* the alias that comes from the deletion of the user
//        pip.exec((err, res) => { console.log(err); console.log(res); });
//
//        keys = await redis.keys('*');
//        console.log(keys);
//    });
    after('Remove user', async function () {
        this.timeout(6000);

        let keys = await redis.keys('*');
        console.log("[ACCOUNT] after-script beginning");
        console.log("[ACCOUNT] Redis Keys before deletion: ");
        console.log(keys);

        await waitForUserReady(() => runGsuiteOperation(gsuiteOperations.getAccount, accountData));
        console.log("[ACCOUNT] GsuiteOps: ");
        await safeDeleteUser(
            () => runGsuiteOperation(gsuiteOperations.deleteAccount, accountData),
            () => runGsuiteOperation(gsuiteOperations.getAccount, accountData)
        );

        const userPrimaryEmail = generatedUsername;
        const userSecondaryEmail = email;

        const pip = redis.pipeline();

        // user
        pip.hdel('user:' + userPK, 'GsuiteAccount');
        pip.hdel('user:' + userPK, 'SecondaryEmail');
        pip.del('primary:' + userPK, 'primary:' + userSecondaryEmail, 'id:' + userPrimaryEmail, 'secondary:' + userPrimaryEmail);
        // alias
        pip.hdel('user:' + userPK, 'GsuiteAlias');
        pip.del('alias:' + userPK);
        pip.del('primary:' + userAlias); 
        pip.srem('alias:' + userPrimaryEmail, userAlias); // this to remove *from redis* the alias that comes from the deletion of the user

        await pip.exec((err, res) => { console.log(err); console.log(res); });

        console.log("[ACCOUNT] Redis keys after deletion: ");
        keys = await redis.keys('*');
        console.log(keys?.length > 0 ? keys : 'No keys found: Redis is empty (Did Cris understand this right?)');
        console.log("[ACCOUNT] Account deleted successfully");
        console.log("[ACCOUNT] End after-script");
    });

    describe('PUT /account/:username/alias', () => {
        delay(2000); // because they've just been created by the before

        describe('Create', () => {
            it('Should make an alias if valid', async () => {
                const payload = JSON.parse(JSON.stringify(data));

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'create alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(201);
                body.success.should.equal(true);
            });

            // TODO: Skipped until checked
            it.skip('Should not make an alias if already present', async () => {
                const payload = JSON.parse(JSON.stringify(data));

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'fail create alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(409);
                body.success.should.equal(false);
            });

            it.skip('Should not make an alias if no :username in url', async () => {
                // THIS should call the controller defined in server.js, which is commented out.
                // Test is skipped until i fix that
                const payload = JSON.parse(JSON.stringify(data));
                const emptySubjectId = '';

                const res = await request({
                    uri: '/account/' + emptySubjectId + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'fail create alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(404); // OR 500?
                body.success.should.equal(false);
            });

            it.skip('Should not make an alias if no operation in payload', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                payload.operation = '';

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'fail create alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(400);
                body.success.should.equal(false);
            });

            it.skip('Should not make an alias if no operation in payload', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                delete payload.operation;

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'fail create alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(400);
                body.success.should.equal(false);
            });

            it.skip('Should not make an alias if no aliasName in payload', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                payload.aliasName = '';

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'fail create alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(400);
                body.success.should.equal(false);
            });

            it.skip('Should not make an alias if no aliasName in payload', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                delete payload.aliasName;

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'fail create alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(400);
                body.success.should.equal(false);
            });

            it.skip('Should not add an alias if mistaken payload (swap user&alias)', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                payload.aliasName = userPK;

                const res = await request({
                    uri: '/account/' + userAlias + '/group',
                    method: 'PUT',
                    headers: { 'test-title': 'fail add alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(400);
                body.success.should.equal(false);

                console.log(body);
            });

            it.skip('Should not remove an alias if mistaken payload (swap user&alias)', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                payload.operation = 'remove';
                payload.aliasName = userPK;

                const res = await request({
                    uri: '/account/' + userAlias + '/group',
                    method: 'PUT',
                    headers: { 'test-title': 'fail remove alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(400);
                body.success.should.equal(false);

                console.log(body);
            });
        });

        describe.skip('Read', () => {
            it('#GET: Should correctly retrieve single alias', async () => {
                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'GET',
                    headers: { 'test-title': 'get alias' },
                });

                body = res.body;
                res.statusCode.should.equal(200);
                body.success.should.equal(true);
            });

            it('#GET: Should correctly retrieve multiple aliases', async () => {
                // First add a second alias
                const payload = JSON.parse(JSON.stringify(data));
                payload.aliasName = otherAlias;

                let res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'get alias (add 2nd alias)' },
                    body: payload,
                });

                let body = res.body;
                res.statusCode.should.equal(201);
                body.success.should.equal(true);

                res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'GET',
                    headers: { 'test-title': 'get alias' },
                });

                body = res.body;
                res.statusCode.should.equal(200);
                body.success.should.equal(true);
            });
        });

        describe.skip('Delete', () => {
            delay(1500);

            it('Should remove an alias if valid', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                payload.operation = 'remove';

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'remove alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(200);
                body.success.should.equal(true);
            });

            it('Should not remove an alias if none', async () => {
                const payload = JSON.parse(JSON.stringify(data));
                payload.operation = 'remove';

                const res = await request({
                    uri: '/account/' + userPK + '/alias',
                    method: 'PUT',
                    headers: { 'test-title': 'fail remove alias' },
                    body: payload,
                });

                const body = res.body;
                res.statusCode.should.equal(400);
                body.success.should.equal(false);
            });

            delay(2000); // for the final removal called in the "after"
        });
    });

    delay(2000);
});
