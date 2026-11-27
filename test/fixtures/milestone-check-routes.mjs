export default
[
  {"id":"F1","scenario":"failed with outstanding repairs","route":{"factory":"fixtureFactory","order":"wo32","check":26,"owner":"manager","action":"repair","reason":"Follow the existing fix cards for this attempt."}},
  {"id":"F2","scenario":"running with pending proof","route":{"factory":"fixtureFactory","order":"wo33","check":40,"owner":"none","action":"wait","reason":"Waiting for this attempt’s proof results."}},
  {"id":"F3","scenario":"cannot run under hold","route":{"factory":"fixtureFactory","order":"wo34","check":41,"owner":"none","action":"hold","reason":"The current factory setting holds this milestone until the check can run."}},
  {"id":"F4","scenario":"persisted factory rule with passing story evidence","route":{"factory":"fixtureFactory","order":"wo35","check":42,"owner":"none","action":"settled","reason":"The factory rule counted this milestone on its stories’ verified tests."}},
  {"id":"F5","scenario":"actual escalation under ask","route":{"factory":"fixtureFactory","order":"wo36","check":43,"owner":"person","action":"review","reason":"This attempt requires a person’s decision."}},
  {"id":"F6","scenario":"completed repairs permit a bounded retry","route":{"factory":"fixtureFactory","order":"wo37","check":44,"owner":"manager","action":"retry","reason":"All fix cards for this attempt have finished and merged. Check readiness and retry."}},
  {"id":"F7","scenario":"verified passing check","route":{"factory":"fixtureFactory","order":"wo38","check":45,"owner":"none","action":"settled","reason":"The milestone check passed."}},
  {"id":"F8","scenario":"missing action authority","route":null}
]
