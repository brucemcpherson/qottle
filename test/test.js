const test = require("ava");
const Qottle = require('../src/qottle');
const { pTimeout } = Qottle;

test("init", (t) => {
  const q = new Qottle()
  t.deepEqual(q.list, []);
  t.is(q.queueSize, 0);
  t.is(q.finishedSize, 0);
  t.is(q.activeSize, 0);
});

test("check key skipping single threaded", t => {
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
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

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
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
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

  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));
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
  t.is(q.isStarted, false);
  q.on("startqueue", () => {
    console.log("queue started");
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const order = mss.sort((a, b) => a - b);
  const p = mss.map((m) =>
    q.add(() => pTimeout(m), { key: m, priority: m })
  );
  

  q.startQueue();
  t.is(q.isStarted, true);
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
    immediate: false
  });
  const mss = [4000, 1000, 4000, 2000, 4000];
  const p = mss.map((m) =>
    q.add(() => pTimeout(m), { key: m})
  );
  q.list.filter(f => f.key === 2000).forEach(f => q.remove(f))
  const list = q.list.map(k => k.key)
  t.deepEqual(
    list,
    mss.filter((f) => f !== 2000)
  );
  q.startQueue()
  return Promise.all(p)
  
})


test("check no key skipping multi threaded rate limited - 1 every 2 seconds", (t) => {
  const q = new Qottle({
    concurrent: 1,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 1,
    rateLimitPeriod: 2000
  });

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(results.map(f => f.entry.key), mss);
    results.forEach((f,i) => { 
      // the wait times for each should be close to the ratelimitperiod except for the first
      const w = f.entry.rateLimitPeriod - f.entry.waitTime
      t.is((w < 200 && w > 0) || !i,  true)
    })
    return results;
  });
});


test("check no key skipping multiple threaded rate limited - 1 every 3 seconds", (t) => {
  const q = new Qottle({
    concurrent: 5,
    skipDuplicates: false,
    rateLimited: true,
    rateLimitMax: 1,
    rateLimitPeriod: 3000
  });

  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    results.forEach((f, i) => {
      // harder to test this one as the concurrent will all keep trying
      t.is(f.entry.waitTime > f.entry.rateLimitPeriod || !i, true);
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
  q.on("ratewait", (pack) => {
    waits += pack.waitTime
  });
  const mss = [2, 1, 3, 5, 4];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    const w = results.reduce((p,c) => {
      return p + c.entry.waitTime
    }, 0);
    // total waits should be all those reported
    t.is(w,waits)
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
    rateLimitDelay: 5000
  });
  // everybody should have  to wait
  let waits = 0;
  q.on("ratewait", (pack) => {
    waits += pack.waitTime;
  });
  const mss = [20, 1000, 300, 500, 40];
  const p = mss.map((m) => q.add(() => pTimeout(m), { key: m }));

  return Promise.all(p).then((results) => {
    t.deepEqual(
      results.map((f) => f.entry.key),
      mss
    );
    const w = results.reduce((p, c) => {
      return p + c.entry.waitTime;
    }, 0);
    // total waits should be all those reported
    t.is(w, waits);
    return results;
  });
});

