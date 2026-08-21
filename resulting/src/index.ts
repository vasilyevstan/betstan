import { runResultingService } from "./service/startup";

if (require.main === module) {
  void runResultingService();
}
