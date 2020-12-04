const test = require("ava");
const Qottle = require("../src/qottle");

const LEEWAY = 100;

test("init", (t) => {
  const q = new Qottle();
  t.deepEqual(q.list(), []);
  t.is(q.queueSize(), 0);
  t.is(q.stickySize(), 0);
  t.is(q.activeSize(), 0);
});

test("adding immediate", (t) => {
  const q = new Qottle();
  q.on("add", ({ entry }) => {
    t.is(entry.status, "queued");
  });

  // should start right away
  return q.add(({ entry }) => {
    t.is(entry.status, "active");
  });
});

test("adding stopped", (t) => {
  const q = new Qottle({
    immediate: false,
  });

  q.on("add", ({ entry }) => {
    t.is(entry.status, "queued");
  });

  const p = q.add(({ entry }) => {
    return t.is(entry.status, "active");
  });

  // wait a bit then start the queue
  q.timer(100).then(() => q.startQueue());

  return p.then(({ entry }) => {
    t.is(entry.status, "finish");
    return { entry };
  });
});

test("error handling - dont catch", (t) => {
  const q = new Qottle({
    concurrent: 3,
    catchError: false,
  });
  q.on("error", ({ entry, error }) => {
    t.is(error.message, entry.key);
    t.is(entry.key, "fail");
  });
  const order = [];
  q.on("finish", ({ entry }) => {
    order.push(entry.key);
  });
  const mss = [2000, 500];
  const mr = mss.map((f) => q.add(() => q.timer(f), { key: f }));

  return Promise.all(
    mr.concat(
      q
        .add(
          ({ entry }) => {
            throw new Error(entry.key);
          },
          { key: "fail" }
        )
        .catch(({ error, entry }) => {
          t.is(error.message, entry.key);
          t.is(entry.key, entry.key);
        })
    )
  ).then((results) => {
    return q.timer(1000).then(() =>
      t.deepEqual(
        order,
        mss.sort((a, b) => a - b)
      )
    );
  });
});

test("error handling - catch", (t) => {
  const q = new Qottle({
    concurrent: 3,
    catchError: true,
  });
  q.on("error", ({ entry, error }) => {
    t.is(error.message, entry.key);
    t.is(entry.key, "fail");
  });
  q.on("finish", ({ error }) => {
    t.is(error, undefined);
  });

  return Promise.all([
    q.add(() => q.timer(500), { key: "b.second" }),
    q.add(() => q.timer(50), { key: "b.first" }),
    q
      .add(
        ({ entry }) => {
          throw new Error(entry.key);
        },
        { key: "fail" }
      )
      .then(({ error, entry }) => {
        t.is(error.message, entry.key);
        t.is(entry.key, entry.key);
      }),
  ]);
});

test("check key skipping single threaded", (t) => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: true,
  });
  // this signal should match the original order
  const finishedOrder = [];
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  // should do it in order and skip dups
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.filter((f, i, a) => a.indexOf(f) === i);
  const skip = mss.filter((f, i, a) => a.indexOf(f) !== i);
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));

  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result);
    const skipped = results
      .filter((f) => f.entry.skipped)
      .map((f) => f.entry.key);

    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);
    t.deepEqual(skipped, skip);

    return results;
  });
});

test("check key skipping multi threaded", (t) => {
  const q = new Qottle({
    concurrent: 10,
    skipDuplicates: true,
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss
    .filter((f, i, a) => a.indexOf(f) === i)
    .sort((a, b) => a - b);
  const skip = mss
    .filter((f, i, a) => a.indexOf(f) !== i)
    .sort((a, b) => a - b);
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));
  const finishedOrder = [];
  // this time the order should be the quickest to run finished 1st
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result)
      .sort((a, b) => a - b);
    const skipped = results
      .filter((f) => f.entry.skipped)
      .map((f) => f.entry.key)
      .sort((a, b) => a - b);
    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);
    t.deepEqual(skipped, skip);

    return results;
  });
});

test("check no key multi threaded", (t) => {
  const q = new Qottle({
    concurrent: 10,
    skipDuplicates: true,
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss
    .filter((f, i, a) => a.indexOf(f) === i)
    .sort((a, b) => a - b);

  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));
  const finishedOrder = [];
  // this time the order should be the quickest to run finished 1st
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result)
      .sort((a, b) => a - b);

    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);

    return results;
  });
});

test("priorities no skipping multi threaded", (t) => {
  const q = new Qottle({
    concurrent: 10,
    skipDuplicates: false,
    immediate: false,
  });
  // the start order should be obey priority since we're not auto starting
  const startOrder = [];
  q.on("start", (pack) => {
    startOrder.push(pack.entry.key);
  });
  t.is(q.isStarted(), false);
  q.on("startqueue", () => {
    console.log("queue started");
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.sort((a, b) => a - b);
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m, priority: m }));

  q.startQueue();
  t.is(q.isStarted(), true);
  return Promise.all(p).then((results) => {
    const ordered = results.map((f) => f.result);
    t.deepEqual(startOrder, order);
    t.deepEqual(ordered, mss);
    return results;
  });
});

test("removing", (t) => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: false,
    immediate: false,
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));
  q.list()
    .filter((f) => f.key === 2000)
    .forEach((f) => q.remove(f));
  const list = q.list().map((k) => k.key);
  t.deepEqual(
    list,
    mss.filter((f) => f !== 2000)
  );
  q.startQueue();
  return Promise.all(p);
});

test("check no key skipping multi threaded rate limited - 1 every 2 seconds", (t) => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 1,
    rateLimitPeriod: 2000,
  });

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    results.forEach((f, i) => {
      // the wait times for each should be close to the ratelimitperiod except for the first
      const w = Math.abs(f.entry.rateLimitPeriod - f.entry.waitTime);
      // within LEEWAYms of expectation
      t.is(w < LEEWAY || !i, true);
    });
    return results;
  });
});

test("check no key skipping multiple threaded rate limited - 1 every 3 seconds", (t) => {
  const q = new Qottle({
    concurrent: 5,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 1,
    rateLimitPeriod: 3000,
  });

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    results.forEach((f, i) => {
      // harder to test this one as the concurrent will all keep trying
      const w = Math.abs(f.entry.rateLimitPeriod - f.entry.waitTime);
      // within LEEWAYms of expectation
      t.is(w < LEEWAY || !i, true);
    });
    return results;
  });
});

test("check no key skipping multiple threaded rate limited - 2 every 1.5 seconds", (t) => {
  const q = new Qottle({
    concurrent: 3,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 2,
    rateLimitPeriod: 1500,
  });
  // everybody should have  to wait
  let waits = 0;

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));
  // because the only 2 of them should be held up because of rate limits
  const expectedWait = 2 * 1500;
  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );

    const w = results.reduce((p, c) => {
      return p + c.entry.waitTime;
    }, 0);
    t.is(Math.abs(w - expectedWait) < LEEWAY, true);
    return results;
  });
});

test("check delay with ratelimit between each call plus delay period", (t) => {
  const q = new Qottle({
    concurrent: 3,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 2,
    rateLimitPeriod: 1500,
    rateLimitDelay: 3000,
  });

  const mss = [20, 1000, 300, 500, 40];
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));

  // 4 of these should be delated
  const expectedWait = (mss.length - 1) * q.options.rateLimitDelay;
  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    // make sure it waited at least long enough between each one
    const delays = results
      .slice(1)
      .map((f, i) => f.entry.startedAt - results[i].entry.startedAt);
    t.is(
      delays.every((f) => q.options.rateLimitDelay <= f),
      true
    );
    return Promise.resolve(results);
  });
});

test("check sticky", (t) => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: true,
    sticky: true,
  });
  // this signal should match the original order
  const finishedOrder = [];
  q.on("finish", (pack) => {
    finishedOrder.push(pack.entry.key);
  });

  // should do it in order and skip dups
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.filter((f, i, a) => a.indexOf(f) === i);
  const skip = mss.filter((f, i, a) => a.indexOf(f) !== i);
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));
  q.on("empty", () => {
    q.list().forEach((f) => {
      t.is(f.error, undefined);
    });
  });
  return Promise.all(p).then((results) => {
    const ordered = results
      .filter((f) => !f.entry.skipped)
      .map((f) => f.result);
    const skipped = results
      .filter((f) => f.entry.skipped)
      .map((f) => f.entry.key);

    t.deepEqual(finishedOrder, ordered);
    t.deepEqual(ordered, order);
    t.deepEqual(skipped, skip);
    t.is(q.list().length, ordered.length);
    t.is(
      q.list().every((f) => f.status === "finish"),
      true
    );
    return results;
  });
});

test("check non sticky", (t) => {
  const q = new Qottle({
    concurrent: 5,
    skipDuplicates: true,
    sticky: false,
  });
  // this signal should match the original order
  const finishedOrder = [];
  q.on("empty", (pack) => {
    t.is(q.list().length, 0);
  });

  // should do it in order and skip dups
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.filter((f, i, a) => a.indexOf(f) === i);
  const skip = mss.filter((f, i, a) => a.indexOf(f) !== i);
  const p = mss.map((m) => q.add(() => q.timer(m), { key: m }));
  q.on("empty", () => {
    q.list().forEach((f) => {
      t.is(f.error, undefined);
    });
  });
  return Promise.all(p).then((results) => {
    t.is(q.list().length, 0);
    return results;
  });
});

test("check single threaded continuous polling", (t) => {
  const q = new Qottle({
    // polling every 1 seconds
    concurrent: 1,
    rateLimited: true,
    rateLimitPeriod: 10 * 1000,
    rateLimitMax: 5,
  });
  // this will resolve and get out of the test after some number of iterations
  const ITERATIONS = 10;

  // this just waits for a while, then returns how long it waited
  // you could handle your api result here
  const action = () => q.timer(Math.floor(Math.random() * 2000));

  // or you could handle it with an event
  const results = [];
  q.on("finish", ({ entry, result }) => {
    results.push({
      entry,
      result,
    });
  });

  // add to the queue until target number of iterations is reached
  const adder = ({ entry, result } = { entry: { key: 0 } }) =>
    q
      .add(() => action(), { key: entry.key + 1 })
      .then(({ entry, result }) =>
        entry.key < ITERATIONS
          ? adder({ entry, result })
          : Promise.resolve({ entry, result })
      );

  // kick the poller off
  return adder().then(({ entry, result }) => {
    // this will happen when the required number of iterations are reached
    // the number of results and the last entry processed should be the same
    t.is(results.length, entry.key);
    t.is(results.length, ITERATIONS);
  });
});

test("simulate pubsub with sticky history", (t) => {
  // we'll set up a queue to simulate a publisher
  const pub = new Qottle({
    immediate: false,
    concurrent: 8,
    name: "pub",
  });

  // and populate it with a bunch of messages to publish out at random times
  // some will be duplicates on purpose
  const ps = Promise.all(
    Array.from(new Array(20)).map((f, i, a) =>
      pub.add(
        () => {
          return pub.timer(Math.floor(1000 * Math.random()));
        },
        // cause some duplicates to happen
        { key: Math.floor(a.length * Math.random()) }
      )
    )
  );

  // in our simulation - publishing means adding it to the subscription queue,
  // so first create a subscription queue
  const q = new Qottle({
    skipDuplicates: true,
    sticky: true,
    name: "sub",
  });

  // this is what the subscription queue will do when it receives an entry
  // just hang around abit then store result
  const subbed = [];
  const dealWithSub = ({ entry }) => q.timer(Math.floor(2000 * Math.random()));

  // here's a pub entering the sub queue
  pub.on("finish", ({ entry }) => {
    q.add(dealWithSub, {
      key: entry.key,
    }).then((pack) => {
      // both skipped and finished resolve
      const { entry, result, error } = pack;
      subbed.push(pack);
      if (entry.skipped) {
        t.is(result, undefined);
        t.not(error, undefined);
      } else {
        t.not(result, undefined);
        t.is(error, undefined);
      }
      return pack;
    });
  });

  // now we can start publishing
  pub.startQueue();

  // we'll retunr this to close the test
  let resolve = null;
  const done = new Promise((r) => {
    resolve = r;
  });

  // because this is a simulated end - give the q time to settle before  finally resolving
  ps.then((pubbed) => {
    return q.timer(2000).then(() => {
      resolve(pubbed);
    });
  });

  return done.then((pubbed) => {
    t.is(subbed.length, pubbed.length);
    console.log(
      `  ..${
        subbed.filter((f) => f.entry.skipped).length
      } pubs were intentionally skipped from ${subbed.length}`
    );
    return subbed;
  });
});

test("simulate apps script polling from vue client", t => { 
  const q = new Qottle({
    // polling only 1 at a time, no more than 5 every 10 seconds
    // and with at least 2 secs between each
    concurrent: 1,
    rateLimited: true,
    rateLimitPeriod: 10 * 1000,
    rateLimitMax: 3,
    rateLimitDelay: 2500,
  });
  const RANDOMTIME = 2000;
  // simuate getting some data server side - just tun a few times - then cancel
  const ITERATIONS = 5;
  let latestData = null

  q.on('finish', ({ entry }) => { 
    // for this sim, the runtimeshould always be less that the max random time
    t.is(entry.runTime <= RANDOMTIME, true);
  })

  // this simulates a get taking some random time
  const getNext = ({ entry }) => {
    return q.timer(Math.random() * RANDOMTIME).then(() => [
      {
        category: "food",
        value: entry.context.count,
        user: "john",
      },
    ]);
  }

  const adder = ({ entry }) =>
    q.add(({ entry }) => getNext({ entry }), {
      context: {...entry.context, count: entry.context.count+1},
      key: entry.key + 1
    }).then(({ entry, result }) => {
      latestData = result
      if (entry.key < ITERATIONS) {
        t.not(latestData, undefined)
        return adder({ entry, result })
      } else {
        return Promise.resolve({result})
      } 
    });
  
  // kick the whole thing off
  return adder({
    entry: {
      key: 0,
      context: {
        value: 'anything you want',
        count: 0
      }
    }
  }).then(({ result, entry }) => { 
    
    t.not(result, undefined)
    t.is(result[0].value, ITERATIONS);
    return result
  })


})
