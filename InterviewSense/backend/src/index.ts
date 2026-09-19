import { app } from './server.js';

const port = Number(process.env.PORT ?? 4000);

app.listen(port, '0.0.0.0', () => {
  console.log(`InterviewSense API running on port ${port}`);
});
