const chai = require('chai');

const should = chai.should();
const crypto = require('crypto');
const { request } = require('./test-helper');
const { runGsuiteOperation, gsuiteOperations } = require('../lib/google-suite');

const redis = require('../lib/redis').db;

// EXTRA FUNCTIONS! 

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

// THE REAL TESTS! But first some variables. 

describe('Accounts', () => {
    const name = 'Automated';
    const surname = 'APITest';
    const generatedUsername = name.toLowerCase() + '.' + surname.toLowerCase() + '@aegee.eu';
    const email = 'alternatemail817263@mailinator.com';
    const antenna = 'AEGEE-Tallahassee';
    const password = 'AEGEE-Europe';
    const SHA1Password = crypto.createHash('sha1').update(JSON.stringify(password)).digest('hex');
    const userPK = 'totallyuuid-account';

    const data = {
        primaryEmail: generatedUsername,
        name: {
            givenName: name,
            familyName: surname,
        },
        secondaryEmail: email,
        password: SHA1Password,
        antenna,
        userPK,
    };

    // The function executed at the end of all the tests. 
    after('Remove user', async function () {
        this.timeout(60000);

        let keys = await redis.keys('*');
        console.log("[ACCOUNT] after-script beginning");
        console.log("[ACCOUNT] Redis Keys before deletion: ");
        console.log(keys);

        await waitForUserReady(() => runGsuiteOperation(gsuiteOperations.getAccount, data));
//        const result = await runGsuiteOperation(gsuiteOperations.deleteAccount, data);
//        await waitForUserDeleted(() => runGsuiteOperation(gsuiteOperations.getAccount, data));
        console.log("[ACCOUNT] GsuiteOps: ");
        await safeDeleteUser(
            () => runGsuiteOperation(gsuiteOperations.deleteAccount, data),
            () => runGsuiteOperation(gsuiteOperations.getAccount, data)
        );

        const userPrimaryEmail = generatedUsername;
        const userSecondaryEmail = email;

        const pip = redis.pipeline();

        // user
        pip.hdel('user:' + userPK, 'GsuiteAccount');
        pip.hdel('user:' + userPK, 'SecondaryEmail');
        pip.del('primary:' + userPK, 'primary:' + userSecondaryEmail, 'id:' + userPrimaryEmail, 'secondary:' + userPrimaryEmail);
       //pip.del('primary:' + 'other_alias_for_test@aegee.eu', 'alias:' + generatedUsername); 
        await pip.exec((err, res) => { console.log(err); console.log(res); });

        console.log("[ACCOUNT] Redis keys after deletion: ");
        keys = await redis.keys('*');
        console.log(keys?.length > 0 ? keys : 'No keys found: Redis is empty (Did Cris understand this right?)');
        console.log("[ACCOUNT] Account deleted successfully");
        console.log("[ACCOUNT] End after-script");
    });

    // THE REAL TESTS!

    describe('POST /account', function () {
        it('Should add an account if valid', async () => {
            this.timeout(3000);
            const payload = JSON.parse(JSON.stringify(data));

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(201);
            body.success.should.equal(true);
        });

        it.skip('Should not add an account if already existing', async () => {
            const payload = JSON.parse(JSON.stringify(data));

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(409);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if without primaryEmail', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            delete payload.primaryEmail;

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if primaryEmail is empty', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            payload.primaryEmail = '';

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if without secondaryEmail', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            delete payload.secondaryEmail;

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if secondaryEmail is empty', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            payload.secondaryEmail = '';

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if without password', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            delete payload.password;

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if password is empty', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            payload.password = '';

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if without antenna', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            delete payload.antenna;

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if antenna is empty', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            payload.antenna = '';

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if without name', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            delete payload.name.givenName;

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if name is empty', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            payload.name.givenName = '';

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if without surname', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            delete payload.name.familyName;

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if surname is empty', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            payload.name.familyName = '';

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if without userPK', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            delete payload.userPK;

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });

        it.skip('Should not add an account if userPK is empty', async () => {
            const payload = JSON.parse(JSON.stringify(data));
            payload.userPK = '';

            const res = await request({
                uri: '/account',
                method: 'POST',
                headers: { 'test-title': 'fail create account' },
                body: payload,
            });

            const body = res.body;
            res.statusCode.should.equal(400);
            body.success.should.equal(false);
        });
    });

    delay(2345);

    xdescribe('GET /account', () => {
        it('Should list all accounts if valid', async () => {
		echo("this test is empty");
        });
    });
});
